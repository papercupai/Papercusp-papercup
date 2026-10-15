/**
 * Provider push wake (plan linear-asana-task-sync-2026-10-05, P-008 / WI-10006368, decision D-016).
 *
 * Some providers can call us when something changes (Asana webhooks). That only ever WAKES the
 * source's next sync ({@link wakeConnectorSource}, D-003): a delivery's body is never read as data,
 * so a forged or replayed delivery can at most make a sync happen sooner.
 *
 *  - SCHEME: the provider descriptor's `push` block names the handshake header and the signature
 *    header (plugin-sdk ProviderPushDescriptor). This module verifies it; nothing here branches on
 *    a provider id.
 *  - SUBSCRIBE: {@link reconcileConnectorPush} (run by the connector-sync routine) asks a provider
 *    that declares `push.subscribe` to make its remote webhooks match the source config and point at
 *    the source's public hook URL (the user's own tunnel, else the Papercusp relay). The resulting
 *    set lives at `data_sources.cursor.push`, a host-owned cursor key like `wake`.
 *  - HANDSHAKE: Asana sends each new webhook's secret once, inside the create call, with no webhook
 *    id. So the host opens a window (`cursor.push.handshakeOpenUntil`) just before `push.subscribe`
 *    and closes it after; a handshake outside an open window is refused. Accepted secrets are stored
 *    encrypted under the operator database key (migration 1400, connector_push_secrets), several per
 *    source (one per remote webhook).
 *  - DELIVERY: an HMAC-SHA256 over the raw body that matches any of the source's secrets wakes it.
 *
 * Without Remote access or a public URL nothing is subscribed, and polling alone keeps working.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type postgres from 'postgres';
import {
  PROVIDER_PUSH_SUBSCRIBE_CAPABILITY,
  PROVIDER_PUSH_UNSUBSCRIBE_CAPABILITY,
  PROVIDER_INGRESS_NORMALIZE_CAPABILITY,
  type HostFetch,
  type ProviderPushDescriptor,
  type ProviderPushSubscription,
  type ProviderServices,
} from '@papercusp/plugin-sdk';
import { getRemoteAccess } from '../connected-apps/remote-access';
import { getDbEncryptionKey } from '../db-encryption';
import { webhookUrls } from '../agent-tools/triggers/_webhook';
import type { WebhookDeliveryRequest, WebhookDeliveryResponse } from '../external-triggers/webhook';
import { readyProviderRegistry, type ProviderRegistry, type RegisteredProvider } from '../integrations/provider-registry';
import { resolveProviderServices } from '../integrations/service-credentials';
import { createSourceHostFetch } from '../integrations/source-host-fetch';
import { clientRegistrationRefOf, readOAuthClientRegistration } from '../integrations/oauth-client-registration';
import { readProviderCredentialValue } from '../integrations/provider-credentials';
import { DEFAULT_SOURCE_TOKEN_HARNESS } from '../external-triggers/source-store';
import { isWebhookSourceId } from '../external-triggers/webhook-path';
import { CONNECTOR_SYNC_STATUSES, ProviderSyncFailure, wakeConnectorSource, admitConnectorRecord, assertProviderRecords, type ConnectorSourceRow } from './connector-runtime';

/** How long a handshake is accepted after the host opens the window for one `push.subscribe`. */
export const PUSH_HANDSHAKE_WINDOW_SECONDS = 60;
/** After a failed reconcile with nothing changed, wait this long before trying again. */
export const PUSH_RETRY_AFTER_FAILURE_SECONDS = 6 * 60 * 60;
/** Re-check the remote webhooks this often even when nothing changed (a provider may delete one). */
export const PUSH_REFRESH_SECONDS = 24 * 60 * 60;
/** Newest secrets kept per source; older ones belong to webhooks long gone. */
export const PUSH_SECRETS_KEPT_PER_SOURCE = 32;
const MAX_SECRET_CHARS = 512;
const SIGNATURE_HEX = /^[0-9a-f]{64}$/;
const PRINTABLE = /^[\x21-\x7e]+$/;

const SYNCABLE = new Set<string>(CONNECTOR_SYNC_STATUSES);

// ─── State ──────────────────────────────────────────────────────────────────

export interface ConnectorPushState {
  /** The URL the remote webhooks point at, as last reconciled (or attempted). */
  targetUrl: string | null;
  subscriptions: ProviderPushSubscription[];
  /** Hash of the source config the subscriptions were reconciled against. */
  configKey: string | null;
  /** While set and in the future, a handshake for this source is accepted. */
  handshakeOpenUntil: string | null;
  reconciledAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** A provider's subscription list, or null when it is not a list of `{ id, resource }`. */
export function asPushSubscriptions(value: unknown): ProviderPushSubscription[] | null {
  if (!Array.isArray(value)) return null;
  const out: ProviderPushSubscription[] = [];
  for (const entry of value) {
    const id = nonEmpty((entry as { id?: unknown } | null)?.id);
    const resource = nonEmpty((entry as { resource?: unknown } | null)?.resource);
    if (!id || !resource) return null;
    out.push({ id, resource });
  }
  return out;
}

/** The push state stored on a source's cursor; an absent or malformed one reads as empty. */
export function pushStateOf(cursor: unknown): ConnectorPushState {
  const p = isPlainObject(cursor) && isPlainObject(cursor.push) ? cursor.push : {};
  return {
    targetUrl: nonEmpty(p.targetUrl),
    subscriptions: asPushSubscriptions(p.subscriptions) ?? [],
    configKey: nonEmpty(p.configKey),
    handshakeOpenUntil: nonEmpty(p.handshakeOpenUntil),
    reconciledAt: nonEmpty(p.reconciledAt),
    lastError: nonEmpty(p.lastError),
    lastErrorAt: nonEmpty(p.lastErrorAt),
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The source config the provider's subscriptions depend on, as a key-order-independent hash. */
export function pushConfigKey(config: Record<string, unknown> | null | undefined): string {
  return createHash('sha256').update(stableJson(config ?? {})).digest('hex').slice(0, 32);
}

const ageSeconds = (iso: string | null, now: Date): number => {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? (now.getTime() - at) / 1000 : Number.POSITIVE_INFINITY;
};

/**
 * Whether the source's remote webhooks need reconciling now: the target or the config moved, or
 * the last reconcile is older than the refresh period. A failure with nothing changed waits out
 * {@link PUSH_RETRY_AFTER_FAILURE_SECONDS}.
 */
export function pushReconcileDue(state: ConnectorPushState, targetUrl: string, configKey: string, now: Date): boolean {
  if (state.targetUrl !== targetUrl || state.configKey !== configKey) return true;
  if (state.lastErrorAt && ageSeconds(state.lastErrorAt, now) < PUSH_RETRY_AFTER_FAILURE_SECONDS) return false;
  if (state.lastErrorAt) return true;
  return ageSeconds(state.reconciledAt, now) >= PUSH_REFRESH_SECONDS;
}

async function writePushState(
  sql: postgres.Sql,
  source: { workspaceId: string; id: string },
  state: ConnectorPushState,
): Promise<void> {
  // Only the `push` key: the sync driver commits `provider` and the wake pass `wake` concurrently.
  await sql`
    UPDATE harness_shared.data_sources
       SET cursor = jsonb_set(COALESCE(cursor, '{}'::jsonb), '{push}', ${JSON.stringify(state)}::text::jsonb),
           updated_at = now()
     WHERE workspace_id = ${source.workspaceId}
       AND id = ${source.id}::uuid`;
}

// ─── Secrets ────────────────────────────────────────────────────────────────

async function storePushSecret(
  sql: postgres.Sql,
  source: { workspaceId: string; sourceId: string },
  secret: string,
  dbKey: string,
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.connector_push_secrets (workspace_id, source_id, secret_ct)
    VALUES (${source.workspaceId}, ${source.sourceId}::uuid, pgp_sym_encrypt(${secret}, ${dbKey}))`;
  await sql`
    DELETE FROM harness_shared.connector_push_secrets
     WHERE workspace_id = ${source.workspaceId}
       AND source_id = ${source.sourceId}::uuid
       AND id NOT IN (
         SELECT id FROM harness_shared.connector_push_secrets
          WHERE workspace_id = ${source.workspaceId}
            AND source_id = ${source.sourceId}::uuid
          ORDER BY created_at DESC, id
          LIMIT ${PUSH_SECRETS_KEPT_PER_SOURCE})`;
}

async function loadPushSecrets(
  sql: postgres.Sql,
  source: { workspaceId: string; sourceId: string },
  dbKey: string,
): Promise<string[]> {
  const rows = await sql<Array<{ secret: string }>>`
    SELECT pgp_sym_decrypt(secret_ct, ${dbKey}) AS secret
      FROM harness_shared.connector_push_secrets
     WHERE workspace_id = ${source.workspaceId}
       AND source_id = ${source.sourceId}::uuid
     ORDER BY created_at DESC, id
     LIMIT ${PUSH_SECRETS_KEPT_PER_SOURCE}`;
  return rows.map((row) => row.secret);
}

/** Forget every push secret of a source (its webhooks are all gone). */
export async function clearPushSecrets(sql: postgres.Sql, source: { workspaceId: string; sourceId: string }): Promise<void> {
  await sql`
    DELETE FROM harness_shared.connector_push_secrets
     WHERE workspace_id = ${source.workspaceId}
       AND source_id = ${source.sourceId}::uuid`;
}

// ─── Delivery ───────────────────────────────────────────────────────────────

/** True when `header` is the hex HMAC-SHA256 of the raw body under any of `secrets` (constant-time compares). */
export function pushSignatureMatches(input: {
  header: string | null | undefined;
  rawBody: Uint8Array;
  secrets: readonly string[];
  prefix?: string;
}): boolean {
  const raw = (input.header ?? '').trim();
  const prefix = input.prefix ?? '';
  if (!raw.startsWith(prefix)) return false;
  const given = raw.slice(prefix.length).toLowerCase();
  if (!SIGNATURE_HEX.test(given)) return false;
  const candidate = Buffer.from(given, 'hex');
  const body = Buffer.from(input.rawBody);
  let matched = false;
  for (const secret of input.secrets) {
    const expected = createHmac('sha256', secret).update(body).digest();
    // Every secret is compared, so the time taken does not say which one matched.
    if (expected.length === candidate.length && timingSafeEqual(expected, candidate)) matched = true;
  }
  return matched;
}

export interface ConnectorPushTarget {
  workspaceId: string;
  sourceId: string;
  providerId: string;
  status: string;
  push: ProviderPushDescriptor;
  handshakeOpenUntil: Date | null;
}

export interface ConnectorPushDeliveryDependencies {
  sql: postgres.Sql;
  /** The workspace's Remote access switch. Off refuses, as for every hook (R-41). */
  remoteAccessEnabled(workspaceId: string): Promise<boolean>;
  /** The registry to read descriptors from. Production: the ready process registry. */
  registry(): Promise<ProviderRegistry>;
  encryptionKey?: string;
  now?: () => Date;
  wake?: typeof wakeConnectorSource;
  /** Host-only seams; neither credential is handed to provider code. */
  oauthSecretFor?: (provider: RegisteredProvider, registry: ProviderRegistry) => Promise<string | null>;
  credentialFor?: typeof readProviderCredentialValue;
  hostFetchFor?: (provider: RegisteredProvider, source: ConnectorSourceRow, registry: ProviderRegistry) => HostFetch;
  admit?: typeof admitConnectorRecord;
}

function sourceHarness(source: ConnectorSourceRow): string {
  return nonEmpty(source.config?.installSlug)?.trim() || DEFAULT_SOURCE_TOKEN_HARNESS;
}

async function oauthPushSecret(provider: RegisteredProvider, registry: ProviderRegistry): Promise<string | null> {
  const ref = clientRegistrationRefOf(provider.descriptor, registry.list().map((p) => p.descriptor));
  const registration = ref ? await readOAuthClientRegistration(ref) : null;
  if (registration?.clientSecret) return registration.clientSecret;
  if (registration?.clientSecretFile) return (await fs.readFile(registration.clientSecretFile, 'utf8')).trim() || null;
  return null;
}

/** GET challenge at the same existing hook URL, using declared host-held credentials. */
export async function handleConnectorPushVerification(
  sourceId: string, params: URLSearchParams, deps: ConnectorPushDeliveryDependencies,
): Promise<{ status: number; text: string }> {
  const refused = { status: 403, text: 'verification_refused' };
  if (!isWebhookSourceId(sourceId)) return { status: 404, text: 'not_found' };
  const rows = await deps.sql<Array<{ workspaceId: string; kind: string; status: string; config: Record<string, unknown> }>>`
    SELECT workspace_id AS "workspaceId", kind, status, config
      FROM harness_shared.data_sources WHERE id = ${sourceId}::uuid LIMIT 1`;
  const row = rows[0];
  const provider = row ? (await deps.registry()).get(row.kind) : null;
  const v = provider?.descriptor.push?.verification;
  if (!row || !provider || !v || !SYNCABLE.has(row.status)) return { status: 404, text: 'not_found' };
  if (!(await deps.remoteAccessEnabled(row.workspaceId))) return refused;
  // Reject duplicate parameters rather than silently selecting an attacker's first value.
  if ([v.modeParam, v.tokenParam, v.challengeParam].some((key) => params.getAll(key).length !== 1)
    || params.get(v.modeParam) !== v.modeValue) return refused;
  const challenge = params.get(v.challengeParam)!;
  if (!/^[0-9]{1,100}$/.test(challenge)) return refused;
  const harness = nonEmpty(row.config?.installSlug)?.trim() || DEFAULT_SOURCE_TOKEN_HARNESS;
  let stored: string | null;
  try { stored = await (deps.credentialFor ?? readProviderCredentialValue)(provider.descriptor, harness, v.credentialRef); }
  catch { return refused; }
  const token = params.get(v.tokenParam)!;
  if (!stored || token.length > 4096) return refused;
  const expected = createHash('sha256').update(stored).digest();
  const given = createHash('sha256').update(token).digest();
  return timingSafeEqual(expected, given) ? { status: 200, text: challenge } : refused;
}

function refuse(status: number, error: string, extra: Record<string, unknown> = {}): WebhookDeliveryResponse {
  return { status, body: { ok: false, error, ...extra } };
}

/**
 * One POST to `/api/hooks/<source id>` addressed to a connector source. Returns null when the id
 * names no connector source whose provider declares a push scheme, so the caller answers its own
 * 404. Order: source and scheme → syncable status → Remote access → handshake (only inside the
 * window) or signature → wake. Every refusal writes nothing; an accepted delivery writes only the
 * wake.
 */
export async function handleConnectorPushDelivery(
  request: WebhookDeliveryRequest,
  deps: ConnectorPushDeliveryDependencies,
): Promise<WebhookDeliveryResponse | null> {
  const rows = await deps.sql<Array<ConnectorSourceRow & { handshakeOpenUntil: string | null }>>`
    SELECT id::text, workspace_id AS "workspaceId", kind, status, config, cursor,
           owner_user_id AS "ownerUserId", credential_ref AS "credentialRef", scope,
           backfill_status AS "backfillStatus", sync_failure_count AS "failureCount",
           sync_wake_requested_at AS "wakeRequestedAt",
           cursor->'push'->>'handshakeOpenUntil' AS "handshakeOpenUntil"
      FROM harness_shared.data_sources
     WHERE id = ${request.sourceId}::uuid
     LIMIT 1`;
  const row = rows[0];
  if (!row) return null;
  const registry = await deps.registry();
  const provider = registry.get(row.kind);
  const push = provider?.descriptor.push;
  if (!push) return null;
  const openUntil = row.handshakeOpenUntil ? new Date(row.handshakeOpenUntil) : null;
  const target: ConnectorPushTarget = {
    workspaceId: row.workspaceId,
    sourceId: request.sourceId,
    providerId: row.kind,
    status: row.status,
    push,
    handshakeOpenUntil: openUntil && Number.isFinite(openUntil.getTime()) ? openUntil : null,
  };
  if (!SYNCABLE.has(target.status)) return refuse(404, 'not_found');
  if (!(await deps.remoteAccessEnabled(target.workspaceId))) return refuse(403, 'remote_access_off');

  const now = deps.now?.() ?? new Date();
  const dbKey = deps.encryptionKey ?? getDbEncryptionKey();
  const handshakeHeader = push.handshake?.header;
  const offered = handshakeHeader ? request.headers.get(handshakeHeader) : null;
  if (handshakeHeader && offered !== null) {
    if (!target.handshakeOpenUntil || target.handshakeOpenUntil.getTime() <= now.getTime()) {
      return refuse(403, 'handshake_not_expected');
    }
    const secret = offered.trim();
    if (!secret || secret.length > MAX_SECRET_CHARS || !PRINTABLE.test(secret)) return refuse(400, 'handshake_invalid');
    await storePushSecret(deps.sql, target, secret, dbKey);
    return { status: 200, body: { ok: true, handshake: true }, headers: { [handshakeHeader]: secret } };
  }

  let secrets: string[];
  try {
    const appSecret = push.signature.oauthClientSecret && provider
      ? await (deps.oauthSecretFor ?? oauthPushSecret)(provider, registry) : null;
    secrets = push.signature.oauthClientSecret ? (appSecret ? [appSecret] : []) : await loadPushSecrets(deps.sql, target, dbKey);
  } catch { return refuse(401, 'signature_invalid', { reason: 'credential_unavailable' }); }
  if (secrets.length === 0) return refuse(401, 'signature_invalid', { reason: 'no_subscription' });
  if (!pushSignatureMatches({ header: request.headers.get(push.signature.header), rawBody: request.rawBody, secrets, prefix: push.signature.prefix })) {
    return refuse(401, 'signature_invalid', { reason: 'signature_invalid' });
  }
  if (push.delivery === 'normalize' && provider) {
    let envelope: unknown;
    try { envelope = JSON.parse(Buffer.from(request.rawBody).toString('utf8')); }
    catch { return refuse(400, 'invalid_body'); }
    try {
      const fetch = deps.hostFetchFor?.(provider, row, registry) ?? createSourceHostFetch(deps.sql, {
        providerId: provider.descriptor.id, workspaceId: row.workspaceId, harness: sourceHarness(row), registry,
        reconnectRequired: (reason) => new ProviderSyncFailure({ kind: 'auth', message: reason }),
      });
      const result = await provider.adapter.invoke({ source: row.id, capability: PROVIDER_INGRESS_NORMALIZE_CAPABILITY,
        args: { envelope, sourceConfig: row.config ?? {} } }, { fetch });
      const records = (result as { records?: unknown } | null)?.records;
      assertProviderRecords(records, provider);
      for (const record of records) {
        const outcome = await (deps.admit ?? admitConnectorRecord)(deps.sql, { source: row, providerId: provider.descriptor.id, record });
        if (outcome === 'rejected') return refuse(503, 'record_admission_unavailable');
      }
      return { status: 200, body: { ok: true, records: records.length } };
    } catch {
      // Do not acknowledge a lost notification, or return provider error text/credentials.
      return refuse(503, 'normalization_unavailable');
    }
  }
  const woke = await (deps.wake ?? wakeConnectorSource)(deps.sql, { workspaceId: target.workspaceId, sourceId: target.sourceId });
  return { status: 200, body: { ok: true, woke } };
}

// ─── Reconcile ──────────────────────────────────────────────────────────────

export interface ConnectorPushOptions {
  workspaceId: string;
  /** Install slug whose token store holds the source credentials. */
  harness: string;
  sourceIds?: readonly string[];
}

export interface ConnectorPushDeps {
  registry?: ProviderRegistry;
  hostFetchFor?: (provider: RegisteredProvider, sql: postgres.Sql, opts: ConnectorPushOptions) => HostFetch;
  servicesFor?: (provider: RegisteredProvider) => Promise<ProviderServices | undefined>;
  /** The source's public hook URL (own tunnel, else the relay); null when it has none. */
  targetUrlFor?: (sourceId: string) => Promise<string | null>;
  remoteAccessEnabled?: (workspaceId: string) => Promise<boolean>;
  now?: () => Date;
}

export type ConnectorPushOutcomeKind = 'subscribed' | 'current' | 'unsubscribed' | 'skipped' | 'failed';

export interface ConnectorPushOutcome {
  sourceId: string;
  providerId: string;
  outcome: ConnectorPushOutcomeKind;
  /** Remote webhooks the source holds after this pass. */
  subscriptions: number;
  /** Why nothing was subscribed (`remote_access_off`, `no_public_url`, `status:<status>`). */
  reason?: string;
  error?: string;
}

export interface ConnectorPushResult {
  sources: ConnectorPushOutcome[];
}

interface PushSourceRow {
  id: string;
  workspaceId: string;
  kind: string;
  status: string;
  config: Record<string, unknown> | null;
  cursor: Record<string, unknown> | null;
}

function defaultHostFetchFor(registry: ProviderRegistry) {
  return (provider: RegisteredProvider, sql: postgres.Sql, opts: ConnectorPushOptions): HostFetch =>
    createSourceHostFetch(sql, {
      providerId: provider.descriptor.id,
      workspaceId: opts.workspaceId,
      harness: opts.harness,
      registry,
      reconnectRequired: (reason) => new ProviderSyncFailure({ kind: 'auth', message: reason }),
    });
}

async function defaultTargetUrlFor(sourceId: string): Promise<string | null> {
  const urls = await webhookUrls(sourceId);
  return urls.ownTunnel ?? urls.relay;
}

async function defaultRemoteAccessEnabled(workspaceId: string): Promise<boolean> {
  return (await getRemoteAccess(workspaceId)).enabled;
}

const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause)).slice(0, 1000);

/**
 * Make every push-capable source's remote webhooks match its config and its public hook URL
 * (D-016). Runs inside the connector-sync routine before the sync pass. A source without Remote
 * access or a public URL has its webhooks removed (they could not be delivered) and keeps polling.
 * A failure is recorded on `cursor.push.lastError` and reported per source; it never fails the pass.
 */
export async function reconcileConnectorPush(
  sql: postgres.Sql,
  opts: ConnectorPushOptions,
  deps: ConnectorPushDeps = {},
): Promise<ConnectorPushResult> {
  // Await plugin discovery: on a request-only host the bare registry is empty until it runs,
  // which would silently skip every push source (provider-registry-readiness.test.ts).
  const registry = deps.registry ?? (await readyProviderRegistry());
  const pushers = registry
    .list()
    .filter((p) => p.descriptor.push && p.descriptor.capabilities.includes(PROVIDER_PUSH_SUBSCRIBE_CAPABILITY));
  if (pushers.length === 0) return { sources: [] };
  const byKind = new Map(pushers.map((p) => [p.descriptor.id, p]));
  const sources = await sql<PushSourceRow[]>`
    SELECT id::text, workspace_id AS "workspaceId", kind, status, config, cursor
      FROM harness_shared.data_sources
     WHERE workspace_id = ${opts.workspaceId}
       AND kind = ANY(${sql.array([...byKind.keys()])}::text[])
       ${opts.sourceIds ? sql`AND id::text = ANY(${sql.array([...opts.sourceIds])}::text[])` : sql``}
     ORDER BY id`;
  if (sources.length === 0) return { sources: [] };

  const hostFetchFor = deps.hostFetchFor ?? defaultHostFetchFor(registry);
  const servicesFor = deps.servicesFor ?? ((p: RegisteredProvider) => resolveProviderServices(p.descriptor.serviceCredentials));
  const targetUrlFor = deps.targetUrlFor ?? defaultTargetUrlFor;
  const clock = deps.now ?? (() => new Date());
  const remoteOn = await (deps.remoteAccessEnabled ?? defaultRemoteAccessEnabled)(opts.workspaceId).catch(() => false);

  const invoke = async (provider: RegisteredProvider, source: PushSourceRow, capability: string, args: Record<string, unknown>) => {
    const services = await servicesFor(provider);
    return provider.adapter.invoke(
      { source: source.id, capability, args, ...(source.config ? { config: source.config } : {}), ...(services ? { services } : {}) },
      { fetch: hostFetchFor(provider, sql, opts) },
    );
  };

  const unsubscribe = async (provider: RegisteredProvider, source: PushSourceRow, state: ConnectorPushState) => {
    if (provider.descriptor.capabilities.includes(PROVIDER_PUSH_UNSUBSCRIBE_CAPABILITY)) {
      await invoke(provider, source, PROVIDER_PUSH_UNSUBSCRIBE_CAPABILITY, { subscriptions: state.subscriptions });
    }
    await clearPushSecrets(sql, { workspaceId: source.workspaceId, sourceId: source.id });
    await writePushState(sql, source, {
      targetUrl: null, subscriptions: [], configKey: null, handshakeOpenUntil: null,
      reconciledAt: clock().toISOString(), lastError: null, lastErrorAt: null,
    });
  };

  const outcomes: ConnectorPushOutcome[] = [];
  for (const source of sources) {
    const provider = byKind.get(source.kind)!;
    const state = pushStateOf(source.cursor);
    const base = { sourceId: source.id, providerId: provider.descriptor.id };
    let targetUrl: string | null = null;
    try {
      // A source that is not syncing, or that cannot be reached, holds no webhooks.
      const reason = !SYNCABLE.has(source.status)
        ? `status:${source.status}`
        : !remoteOn
          ? 'remote_access_off'
          : (targetUrl = await targetUrlFor(source.id).catch(() => null))
            ? null
            : 'no_public_url';
      if (reason) {
        // An `error` source has lost its token; deleting needs it, so its webhooks are left to lapse.
        const canDelete = source.status !== 'error';
        const backingOff = Boolean(state.lastErrorAt) && ageSeconds(state.lastErrorAt, clock()) < PUSH_RETRY_AFTER_FAILURE_SECONDS;
        if (state.subscriptions.length > 0 && canDelete && !backingOff) {
          await unsubscribe(provider, source, state);
          outcomes.push({ ...base, outcome: 'unsubscribed', subscriptions: 0, reason });
        } else {
          outcomes.push({ ...base, outcome: 'skipped', subscriptions: state.subscriptions.length, reason });
        }
        continue;
      }
      const url = targetUrl as string;
      const configKey = pushConfigKey(source.config);
      if (!pushReconcileDue(state, url, configKey, clock())) {
        outcomes.push({ ...base, outcome: 'current', subscriptions: state.subscriptions.length });
        continue;
      }

      // The handshake window: open (committed) before the provider creates anything, closed after.
      const opened: ConnectorPushState = {
        ...state,
        handshakeOpenUntil: new Date(clock().getTime() + PUSH_HANDSHAKE_WINDOW_SECONDS * 1000).toISOString(),
      };
      await writePushState(sql, source, opened);
      let raw: unknown;
      try {
        raw = await invoke(provider, source, PROVIDER_PUSH_SUBSCRIBE_CAPABILITY, { targetUrl: url, subscriptions: state.subscriptions });
      } catch (cause) {
        await writePushState(sql, source, {
          ...state, targetUrl: url, configKey, handshakeOpenUntil: null,
          lastError: errorText(cause), lastErrorAt: clock().toISOString(),
        });
        outcomes.push({ ...base, outcome: 'failed', subscriptions: state.subscriptions.length, error: errorText(cause) });
        continue;
      }
      const result = isPlainObject(raw) ? raw : {};
      const subscriptions = asPushSubscriptions(result.subscriptions);
      if (!subscriptions) {
        // The provider may have created webhooks we cannot name; keep the old set and retry later.
        const error = `${PROVIDER_PUSH_SUBSCRIBE_CAPABILITY} returned a malformed subscription set`;
        await writePushState(sql, source, {
          ...state, targetUrl: url, configKey, handshakeOpenUntil: null, lastError: error, lastErrorAt: clock().toISOString(),
        });
        outcomes.push({ ...base, outcome: 'failed', subscriptions: state.subscriptions.length, error });
        continue;
      }
      const failures = Array.isArray(result.failures)
        ? result.failures
            .map((f) => `${String((f as { resource?: unknown })?.resource ?? '?')}: ${String((f as { error?: unknown })?.error ?? 'failed')}`)
            .slice(0, 10)
        : [];
      const at = clock().toISOString();
      const error = failures.length > 0 ? failures.join('; ').slice(0, 1000) : null;
      await writePushState(sql, source, {
        targetUrl: url, subscriptions, configKey, handshakeOpenUntil: null,
        reconciledAt: at, lastError: error, lastErrorAt: error ? at : null,
      });
      if (subscriptions.length === 0) await clearPushSecrets(sql, { workspaceId: source.workspaceId, sourceId: source.id });
      outcomes.push({
        ...base,
        outcome: error ? 'failed' : 'subscribed',
        subscriptions: subscriptions.length,
        ...(error ? { error } : {}),
      });
    } catch (cause) {
      await writePushState(sql, source, {
        ...state, handshakeOpenUntil: null, lastError: errorText(cause), lastErrorAt: clock().toISOString(),
      }).catch(() => undefined);
      outcomes.push({ ...base, outcome: 'failed', subscriptions: state.subscriptions.length, error: errorText(cause) });
    }
  }
  return { sources: outcomes };
}

export function formatConnectorPushLog(result: ConnectorPushResult): string {
  const count = (kind: ConnectorPushOutcomeKind) => result.sources.filter((s) => s.outcome === kind).length;
  const failures = result.sources
    .filter((s) => s.outcome === 'failed')
    .map((s) => `${s.sourceId}: ${s.error}`)
    .join('; ');
  return (
    `[connector-push] sources=${result.sources.length} subscribed=${count('subscribed')} current=${count('current')} `
    + `unsubscribed=${count('unsubscribed')} skipped=${count('skipped')} failed=${count('failed')}`
    + (failures ? ` errors=${failures}` : '')
  );
}
