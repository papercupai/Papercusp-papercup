/**
 * Pasted provider credentials (cupboard-distributable-integrations-2026-10-10 P-001;
 * SPEC-R-2-P-001, SPEC-R-7-P-001).
 *
 * A provider package declares paste-a-secret fields as data (`descriptor.setup.credentials`). The
 * host owns everything else, the same way it owns OAuth tokens:
 *
 *   - checks each value with the SDK's `providerCredentialValueIssue` (the same check the page runs
 *     before sending, so the two never disagree);
 *   - stores it in the OAuth token store (a 0600 file plus the encrypted PG mirror) under
 *     `provider-setup:<providerId>`. That name contains a colon, which the plain plugin-config read
 *     routes (`/plugins/config`, `/plugins/configs`) refuse as a slug, so they cannot return it;
 *   - reports only whether each field is configured and when it was saved, never the value, its
 *     length, or a prefix;
 *   - hands the value to exactly two host paths: `host.fetch` (as a bearer token for the field's
 *     declared `hosts`) and host-held ingress (P-003). Provider code never receives it. The
 *     account lookup on connect (D-016) is the host itself calling the package's identity endpoint
 *     on one of the field's declared hosts, the same rule host.fetch follows.
 */
import {
  providerCredentialForHost,
  providerCredentialValueIssue,
  validateProviderDescriptor,
  type ProviderCredentialField,
  type ProviderDescriptor,
} from '@papercusp/plugin-sdk';
import { createHash } from 'node:crypto';
import { pinModuleState } from '@papercusp/module-singleton';
import type postgres from 'postgres';
import { fsTokenStorage } from '../oauth/storage-fs';
import type { TokenStorage } from '../oauth/token';
import {
  DEFAULT_SOURCE_TOKEN_HARNESS,
  disconnectOwnedExternalTriggerSources,
  upsertOwnedExternalTriggerSource,
} from '../external-triggers/source-store';
import { fetchProviderIdentity, type ProviderAccountIdentity } from './provider-identity';

const STORE_PREFIX = 'provider-setup:';
const SAVED_AT_SUFFIX = '__saved_at';
/** Separates a provider from the person whose own values an entry holds (D-026). */
const PRINCIPAL_INFIX = ':person:';
/** The store key becomes a file name, so a person id is held to filename-safe characters. */
const PRINCIPAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SESSION_KEY = '__session';
const sessions = pinModuleState('@papercusp/operator-core.integrations.credential-sessions', () => ({
  inFlight: new WeakMap<TokenStorage, Map<string, Promise<ProviderCredentialSession>>>(),
}));

/** HOST-INTERNAL. Only identity metadata may be persisted on a source or returned to a caller. */
export interface ProviderCredentialSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  identity: ProviderAccountIdentity;
  secrets: string[];
  fingerprint: string;
}

function sessionField(body: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => value && typeof value === 'object' && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key] : undefined, body);
}

/** Persistent create/refresh lifecycle for descriptors using setup.credentials, not OAuth. */
export async function providerCredentialSession(
  descriptor: ProviderDescriptor,
  harness: string,
  opts: { storage?: TokenStorage; fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<ProviderCredentialSession> {
  const session = descriptor.setup?.session;
  const fail = (message: string, kind = 'auth') => Object.assign(new Error(`provider_session_${message}`), { kind });
  if (!session || validateProviderDescriptor(descriptor).length) throw fail('descriptor_invalid');
  const storage = opts.storage ?? fsTokenStorage;
  const storeKey = providerSetupStoreKey(descriptor.id);
  const stored = await storage.read(storeKey, harness);
  const values: Record<string, string> = {};
  for (const [parameter, key] of Object.entries(session.parameters)) {
    const value = stored[key];
    const field = descriptor.setup!.credentials!.find((f) => f.key === key)!;
    if (providerCredentialValueIssue(field, value)) throw fail('credential_missing');
    values[parameter] = value as string;
  }
  const fingerprintOf = (data: Record<string, unknown>) => createHash('sha256')
    .update(JSON.stringify([session, Object.values(session.parameters).map((key) => data[key])])).digest('hex');
  const fingerprint = fingerprintOf(stored);
  const now = opts.now ?? Date.now;
  const cached = stored[SESSION_KEY] as ProviderCredentialSession | undefined;
  const prior = cached?.fingerprint === fingerprint && typeof cached.accessToken === 'string' && typeof cached.refreshToken === 'string' ? cached : null;
  if (prior && prior.expiresAt > now() + 30_000) return prior;
  let inFlight = sessions.inFlight.get(storage);
  if (!inFlight) { inFlight = new Map(); sessions.inFlight.set(storage, inFlight); }
  const key = `${harness}\0${descriptor.id}\0${fingerprint}`;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const operation = (async (): Promise<ProviderCredentialSession> => {
    let response: Response;
    try {
      response = await (opts.fetchImpl ?? fetch)(prior ? session.refreshUrl : session.url, {
        method: 'POST', redirect: 'manual', headers: { accept: 'application/json',
          ...(prior ? { authorization: `Bearer ${prior.refreshToken}` } : { 'content-type': 'application/json' }) },
        ...(prior ? {} : { body: JSON.stringify(values) }),
      });
    } catch { throw fail('network_failed', 'transient'); }
    if (!response.ok) {
      throw Object.assign(fail(`http_${response.status}`, response.status === 429 ? 'rate-limited'
        : response.status === 401 || response.status === 403 ? 'auth' : 'transient'),
      response.status === 429 ? { retryAfterSeconds: Number(response.headers.get('retry-after')) || 30 } : {});
    }
    let body: unknown;
    try { body = await response.json(); } catch { throw fail('invalid_json', 'transient'); }
    const active = session.activeField ? sessionField(body, session.activeField) : undefined;
    if (active === false) throw fail('account_inactive');
    if (active !== undefined && typeof active !== 'boolean') throw fail('invalid_active_field', 'transient');
    const accessToken = sessionField(body, session.accessTokenField);
    const refreshToken = sessionField(body, session.refreshTokenField);
    const validToken = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !/[\s\u0000-\u001f\u007f]/.test(value);
    if (!validToken(accessToken) || !validToken(refreshToken)) throw fail('token_missing', 'transient');
    const id = sessionField(body, session.identity.idField);
    const label = session.identity.displayNameField ? sessionField(body, session.identity.displayNameField) : undefined;
    const secrets = [...Object.entries(session.parameters).filter(([, key]) => key !== session.identity.credentialKey)
      .map(([parameter]) => values[parameter]), accessToken, refreshToken, ...(prior ? [prior.accessToken, prior.refreshToken] : [])];
    if (typeof id !== 'string' || !id || (label !== undefined && typeof label !== 'string') ||
      secrets.some((secret) => id.includes(secret) || (typeof label === 'string' && label.includes(secret)))) throw fail('identity_invalid');
    if (prior && prior.identity.providerAccountId !== id) throw fail('identity_changed');
    let expiresAt = now() + session.maxAgeSeconds * 1000;
    // exp is only an expiry hint; authenticity is provided by the fixed HTTPS login endpoint.
    try {
      const exp = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString()).exp;
      if (typeof exp === 'number' && Number.isFinite(exp)) expiresAt = Math.min(expiresAt, exp * 1000);
    } catch { /* Opaque bearer tokens use the descriptor's conservative maximum. */ }
    if (expiresAt <= now() + 30_000) throw fail('token_expired');
    // A password changed/cleared while the exchange ran must never resurrect the old session.
    if (fingerprintOf(await storage.read(storeKey, harness)) !== fingerprint) throw fail('credentials_changed');
    const result: ProviderCredentialSession = { accessToken, refreshToken, expiresAt, fingerprint, secrets,
      identity: { providerAccountId: id, ...(label ? { displayName: label as string } : {}) } };
    await storage.update(storeKey, harness, { [SESSION_KEY]: result });
    return result;
  })().finally(() => { inFlight!.delete(key); });
  inFlight.set(key, operation);
  return operation;
}

/**
 * Whether the provider's pasted credentials connected this source (WI-6554700010008468).
 *
 * Pasting a provider's credentials connects exactly one source per owner whose credential ref is
 * the provider's store entry (`syncProviderCredentialSource`). That ref is what tells the two
 * ingress paths apart: the package socket ingress claims only these sources, and the in-app Slack
 * socket manager claims every other Slack source. Each path skipping the other's sources is what
 * keeps a source on exactly one socket. A second socket on the same app would split the vendor's
 * events between them, and the in-app path cannot read the store entry, so it would mark the
 * source reconnect-required and take it away from the package path too.
 */
export function isPastedCredentialSource(source: { kind: string; credentialRef: string | null }): boolean {
  return source.credentialRef === providerSetupStoreKey(source.kind);
}

/** Token-store plugin key holding one provider's pasted credentials. */
export function providerSetupStoreKey(providerId: string): string {
  return `${STORE_PREFIX}${providerId}`;
}

/**
 * Token-store key holding ONE person's own values of a provider's per-person fields
 * (cupboard-distributable-integrations-2026-10-10 D-026), e.g. their Slack user token. Kept apart
 * from the source's entry, so a person's value never signs a sync or another person's search.
 */
export function providerPrincipalStoreKey(providerId: string, userId: string): string {
  if (!PRINCIPAL_ID_PATTERN.test(userId)) {
    throw new ProviderCredentialError('invalid-principal', `"${userId}" is not a workspace user id`);
  }
  return `${STORE_PREFIX}${providerId}${PRINCIPAL_INFIX}${userId}`;
}

/** What a read may say about one field. Deliberately has no value-bearing member. */
export interface ProviderCredentialStatus {
  key: string;
  label: string;
  help: string | null;
  helpUrl: string | null;
  placeholder: string | null;
  /** The provider's format (regular-expression source), so the page can refuse a bad value before sending. */
  pattern: string | null;
  /** Hosts whose requests carry the value; empty for an ingress-only field. */
  hosts: string[];
  /**
   * Each person stores their own value (D-026); `configured` and `savedAt` then describe the
   * asking person's value, and the field is never part of what connects the source.
   */
  perPrincipal: boolean;
  configured: boolean;
  /** ISO time the current value was saved, or null when not configured. */
  savedAt: string | null;
}

export type ProviderCredentialErrorCode =
  | 'no-credential-fields'
  | 'unknown-field'
  | 'invalid-value'
  | 'empty-request'
  | 'invalid-principal'
  | 'principal-required';

export class ProviderCredentialError extends Error {
  constructor(
    readonly code: ProviderCredentialErrorCode,
    message: string,
    readonly field: string | null = null,
  ) {
    super(message);
    this.name = 'ProviderCredentialError';
  }
}

function fieldsOf(descriptor: Pick<ProviderDescriptor, 'id' | 'setup'>): ProviderCredentialField[] {
  return descriptor.setup?.credentials ?? [];
}

function statusOf(field: ProviderCredentialField, stored: Record<string, unknown>): ProviderCredentialStatus {
  const value = stored[field.key];
  const configured = typeof value === 'string' && value !== '';
  const savedAt = stored[`${field.key}${SAVED_AT_SUFFIX}`];
  return {
    key: field.key,
    label: field.label,
    help: field.help ?? null,
    helpUrl: field.helpUrl ?? null,
    placeholder: field.placeholder ?? null,
    pattern: field.pattern ?? null,
    hosts: [...(field.hosts ?? [])],
    perPrincipal: field.perPrincipal === true,
    configured,
    savedAt: configured && typeof savedAt === 'string' ? savedAt : null,
  };
}

/**
 * Each declared field and whether it is configured. Never includes a value. A per-person field
 * reports `principalUserId`'s own value, and reads as not configured when no person is named.
 */
export async function providerCredentialStatus(
  descriptor: Pick<ProviderDescriptor, 'id' | 'setup'>,
  harness: string,
  storage: TokenStorage = fsTokenStorage,
  principalUserId: string | null = null,
): Promise<ProviderCredentialStatus[]> {
  const fields = fieldsOf(descriptor);
  if (fields.length === 0) return [];
  const stored = await storage.read(providerSetupStoreKey(descriptor.id), harness);
  const ownStored = principalUserId && fields.some((field) => field.perPrincipal)
    ? await storage.read(providerPrincipalStoreKey(descriptor.id, principalUserId), harness)
    : {};
  return fields.map((field) => statusOf(field, field.perPrincipal ? ownStored : stored));
}

/**
 * Check and store some or all of a provider's credentials. Every value is checked before any is
 * written, so a request with one bad value changes nothing. Returns the status, not the values.
 * A per-person field's value is stored as `principalUserId`'s own, and needs one (D-026).
 */
export async function saveProviderCredentials(
  descriptor: Pick<ProviderDescriptor, 'id' | 'setup'>,
  harness: string,
  values: Record<string, unknown>,
  opts: { storage?: TokenStorage; now?: () => Date; principalUserId?: string | null } = {},
): Promise<ProviderCredentialStatus[]> {
  const storage = opts.storage ?? fsTokenStorage;
  const fields = fieldsOf(descriptor);
  if (fields.length === 0) {
    throw new ProviderCredentialError('no-credential-fields', `provider "${descriptor.id}" declares no credential fields`);
  }
  const entries = Object.entries(values);
  if (entries.length === 0) throw new ProviderCredentialError('empty-request', 'no credential values were sent');
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const patch: Record<string, unknown> = {};
  const ownPatch: Record<string, unknown> = {};
  const savedAt = (opts.now?.() ?? new Date()).toISOString();
  for (const [key, value] of entries) {
    const field = byKey.get(key);
    if (!field) {
      throw new ProviderCredentialError('unknown-field', `provider "${descriptor.id}" has no credential field "${key}"`, key);
    }
    const issue = providerCredentialValueIssue(field, value);
    if (issue) throw new ProviderCredentialError('invalid-value', issue, key);
    if (field.perPrincipal && !opts.principalUserId) {
      throw new ProviderCredentialError('principal-required', `${field.label} is stored per person; sign in to store your own`, key);
    }
    const target = field.perPrincipal ? ownPatch : patch;
    target[key] = (value as string).trim();
    target[`${key}${SAVED_AT_SUFFIX}`] = savedAt;
  }
  const ownKey = opts.principalUserId ? providerPrincipalStoreKey(descriptor.id, opts.principalUserId) : null;
  if (Object.keys(patch).length > 0) await storage.update(providerSetupStoreKey(descriptor.id), harness, { ...patch, [SESSION_KEY]: null });
  if (ownKey && Object.keys(ownPatch).length > 0) await storage.update(ownKey, harness, ownPatch);
  return providerCredentialStatus(descriptor, harness, storage, opts.principalUserId ?? null);
}

/** Forget one stored credential; a per-person field forgets `principalUserId`'s own value. */
export async function clearProviderCredential(
  descriptor: Pick<ProviderDescriptor, 'id' | 'setup'>,
  harness: string,
  key: string,
  storage: TokenStorage = fsTokenStorage,
  principalUserId: string | null = null,
): Promise<ProviderCredentialStatus[]> {
  const field = fieldsOf(descriptor).find((candidate) => candidate.key === key);
  if (!field) {
    throw new ProviderCredentialError('unknown-field', `provider "${descriptor.id}" has no credential field "${key}"`, key);
  }
  if (field.perPrincipal && !principalUserId) {
    throw new ProviderCredentialError('principal-required', `${field.label} is stored per person; sign in to clear your own`, key);
  }
  const storeKey = field.perPrincipal ? providerPrincipalStoreKey(descriptor.id, principalUserId!) : providerSetupStoreKey(descriptor.id);
  await storage.update(storeKey, harness, { [key]: null, [`${key}${SAVED_AT_SUFFIX}`]: null, [SESSION_KEY]: null });
  return providerCredentialStatus(descriptor, harness, storage, principalUserId);
}

/** Whose source a pasted credential connects: the signed-in owner, in the active workspace. */
export interface ProviderCredentialSourceOwner {
  workspaceId: string;
  ownerUserId: string;
}

export interface CredentialIdentityOptions {
  harness?: string;
  storage?: TokenStorage;
  fetchImpl?: typeof fetch;
}

/**
 * The account a set of pasted credentials belongs to (plan cupboard-distributable-integrations-
 * 2026-10-10 D-016). When the package declares an identity endpoint (`oauth.identity`) on a host
 * one of its credentials is scoped to, the host asks that endpoint with that credential, exactly
 * as the OAuth connect does with a fresh token. A credential is never sent to a host it does not
 * declare, so a package without such a field gets no request and no label.
 */
async function credentialAccount(
  descriptor: ProviderDescriptor,
  opts: CredentialIdentityOptions,
): Promise<{ account: ProviderAccountIdentity | null; error: string | null }> {
  if (descriptor.setup?.session) {
    const result = await providerCredentialSession(descriptor, opts.harness ?? DEFAULT_SOURCE_TOKEN_HARNESS, opts);
    return { account: result.identity, error: null };
  }
  const identityUrl = descriptor.oauth?.identity?.url;
  if (!identityUrl) return { account: null, error: null };
  const errorPrefix = `provider_${descriptor.id.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`;
  let hostname: string;
  try {
    hostname = new URL(identityUrl).hostname;
  } catch {
    return { account: null, error: `${errorPrefix}_identity_endpoint_invalid` };
  }
  const field = providerCredentialForHost(descriptor, hostname);
  if (!field) return { account: null, error: null };
  const secret = await readProviderCredentialValue(
    descriptor,
    opts.harness ?? DEFAULT_SOURCE_TOKEN_HARNESS,
    field.key,
    opts.storage,
  );
  if (!secret) return { account: null, error: null };
  try {
    return { account: await fetchProviderIdentity(descriptor, secret, errorPrefix, opts.fetchImpl), error: null };
  } catch (error) {
    return { account: null, error: error instanceof Error ? error.message : `${errorPrefix}_identity_failed` };
  }
}

/**
 * Keep the owner's source for a credentials provider in step with what is stored (P-005).
 *
 * The host reaches a provider through an owned source everywhere — capability invocation, the
 * option pickers on workflow settings, ingress — and an OAuth connect creates that source. A
 * pasted credential is the same step for a provider without OAuth: once every declared field is
 * set, the owner has a connected source of the provider's kind whose credential ref is the
 * credential store entry (so it is one source per owner per provider); once any field is cleared,
 * that source is disabled. The value itself still reaches the provider only through host.fetch.
 */
export async function syncProviderCredentialSource(
  sql: postgres.Sql,
  owner: ProviderCredentialSourceOwner,
  descriptor: ProviderDescriptor,
  credentials: readonly ProviderCredentialStatus[],
  opts: CredentialIdentityOptions = {},
): Promise<'connected' | 'disconnected'> {
  const credentialRef = providerSetupStoreKey(descriptor.id);
  // A per-person field is each reader's own (D-026); only the source's fields connect it.
  const sourceFields = credentials.filter((field) => !field.perPrincipal);
  if (sourceFields.length > 0 && sourceFields.every((field) => field.configured)) {
    const identity = await credentialAccount(descriptor, opts);
    const source = await upsertOwnedExternalTriggerSource(sql, {
      workspaceId: owner.workspaceId,
      kind: descriptor.id,
      ownerUserId: owner.ownerUserId,
      credentialRef,
      status: 'connected',
      ...(identity.account ? { config: { accountId: identity.account.providerAccountId,
        ...(identity.account.displayName ? { accountLabel: identity.account.displayName } : {}) } } : {}),
      createdBy: owner.ownerUserId,
    });
    // A credential the provider's identity endpoint refuses still connects (its format passed), but
    // the refusal is recorded on the source where the card reads it, never dropped.
    if (identity.error) {
      await sql`
        UPDATE harness_shared.data_sources SET last_error = ${identity.error}, updated_at = now()
         WHERE id = ${source.id}::uuid`;
    }
    return 'connected';
  }
  await disconnectOwnedExternalTriggerSources(sql, owner.workspaceId, owner.ownerUserId, [descriptor.id], credentialRef);
  return 'disconnected';
}

/**
 * The stored value of one declared field, or null when it is not configured. HOST-INTERNAL: only
 * `host.fetch` (bearer injection) and host-held ingress may call this. Never return its result
 * from a route, a tool, a sync query, or anything provider code can reach.
 */
export async function readProviderCredentialValue(
  descriptor: Pick<ProviderDescriptor, 'id' | 'setup'>,
  harness: string,
  key: string,
  storage: TokenStorage = fsTokenStorage,
): Promise<string | null> {
  if (!fieldsOf(descriptor).some((field) => field.key === key && !field.perPrincipal)) return null;
  const value = (await storage.read(providerSetupStoreKey(descriptor.id), harness))[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * One person's own stored value of a per-person field, or null when they stored none (D-026).
 * HOST-INTERNAL, like {@link readProviderCredentialValue}: only a `host.fetch` bound to that same
 * person may call it.
 */
export async function readProviderPrincipalCredentialValue(
  descriptor: Pick<ProviderDescriptor, 'id' | 'setup'>,
  harness: string,
  principalUserId: string,
  key: string,
  storage: TokenStorage = fsTokenStorage,
): Promise<string | null> {
  if (!fieldsOf(descriptor).some((field) => field.key === key && field.perPrincipal)) return null;
  if (!PRINCIPAL_ID_PATTERN.test(principalUserId)) return null;
  const value = (await storage.read(providerPrincipalStoreKey(descriptor.id, principalUserId), harness))[key];
  return typeof value === 'string' && value !== '' ? value : null;
}
