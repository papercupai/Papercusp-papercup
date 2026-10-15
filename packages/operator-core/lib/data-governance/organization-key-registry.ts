/**
 * The production KEK provider registry and the process-wide organization key service
 * (plan papercusp-enterprise-readiness-roadmap-2026-10-09 P-016b, WI-6554700010012443; decision D-020).
 *
 * organization-keys.ts takes its KEK providers as an argument; this module builds the real ones:
 *  - `aws-kms`: one KMS client per region, chosen from the KEK's ARN. Papercusp calls KMS as its own
 *    control-plane principal (the node provider chain). The customer's key policy grants that principal
 *    Encrypt/Decrypt only for requests whose encryption context names their organization
 *    (awsKmsKekPolicyStatements), so no other organization can use the key through Papercusp.
 *  - `gcp-kms`: every call carries a token minted for the asking organization's OWN delegation account
 *    (hosted-gcp-auth.ts, D-397). The customer grants that account on their key, so a request made for
 *    another organization cannot reach it. A request that names no organization is refused.
 * `test-kms` is never registered here: its key material lives in memory and would be lost on restart.
 *
 * organizationKeyService(sql) returns one service per database handle for the whole process, pinned with
 * pinModuleState so a duplicated module record cannot split its DEK cache or its revocation evictions.
 */
import { KMSClient } from '@aws-sdk/client-kms';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { pinModuleState } from '@papercusp/module-singleton';
import type { Sql } from 'postgres';
import {
  hostedGcpDelegationSource,
  hostedGcpOrganizationIdentityProject,
  organizationDelegationEmail,
  type HostedGcpDelegationSource,
} from '../workspace-host/hosted-gcp-auth';
import {
  KEK_CONTEXT_ORGANIZATION_KEY,
  KekUnavailableError,
  gcpKmsKekProvider,
  regionalAwsKmsKekProvider,
  type KekProvider,
  type KekProviderId,
  type KekWrapContext,
} from './kek-providers';
import {
  createOrganizationKeyCache,
  createOrganizationKeyService,
  type OrganizationKeyCache,
  type OrganizationKeyService,
} from './organization-keys';

export const CLOUD_KMS_SCOPE = 'https://www.googleapis.com/auth/cloudkms';
const IAM_CREDENTIALS_ROOT = 'https://iamcredentials.googleapis.com/v1';
/** A cached token is replaced this long before it expires. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

export type OrganizationKekProviders = Partial<Record<KekProviderId, KekProvider>>;

export interface OrganizationKekProviderOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  /** Default: a real KMSClient for the region, signed by the control-plane node provider chain. */
  readonly createAwsKmsClient?: (region: string) => Pick<KMSClient, 'send'>;
  /** Default: the configured Papercusp delegation source (hosted-gcp-auth.ts). */
  readonly gcpSource?: HostedGcpDelegationSource;
  readonly now?: () => number;
}

function defaultAwsKmsClient(region: string): KMSClient {
  return new KMSClient({ region, credentials: fromNodeProviderChain({ clientConfig: { region } }) });
}

/**
 * A Cloud KMS token source that acts as the asking organization's own delegation account. Tokens are
 * cached per organization until shortly before they expire. Every failure is a typed KMS refusal, so
 * the key service fails closed.
 */
export function organizationGcpKmsTokenSource(options: OrganizationKekProviderOptions = {}): (context: KekWrapContext) => Promise<string> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { token: string; refreshAt: number }>();

  return async (context) => {
    const organizationId = context[KEK_CONTEXT_ORGANIZATION_KEY]?.trim();
    if (!organizationId) {
      throw new KekUnavailableError('gcp-kms', 'kek-access-denied', 'the request names no organization; Cloud KMS is reached only through the organization delegation account (D-397)');
    }
    const cached = cache.get(organizationId);
    if (cached && cached.refreshAt > now()) return cached.token;

    let email: string;
    try {
      email = organizationDelegationEmail(organizationId, hostedGcpOrganizationIdentityProject(env));
    } catch (err) {
      throw new KekUnavailableError('gcp-kms', 'kek-access-denied', (err as Error).message);
    }
    let response: Response;
    try {
      const sourceToken = await (options.gcpSource ?? hostedGcpDelegationSource(env, fetchImpl)).accessToken();
      response = await fetchImpl(`${IAM_CREDENTIALS_ROOT}/projects/-/serviceAccounts/${encodeURIComponent(email)}:generateAccessToken`, {
        method: 'POST',
        headers: { authorization: `Bearer ${sourceToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ delegates: [], scope: [CLOUD_KMS_SCOPE], lifetime: '3600s' }),
      });
    } catch (err) {
      throw new KekUnavailableError('gcp-kms', 'kek-unreachable', `organization token mint failed: ${(err as Error).message}`);
    }
    if (!response.ok) {
      const code = response.status === 401 || response.status === 403 || response.status === 404 ? 'kek-access-denied' : 'kek-unreachable';
      throw new KekUnavailableError('gcp-kms', code, `organization token mint returned HTTP ${response.status}`);
    }
    const minted = (await response.json()) as { accessToken?: string; expireTime?: string };
    if (!minted.accessToken) throw new KekUnavailableError('gcp-kms', 'kek-unreachable', 'organization token mint returned no token');
    const expiresAt = minted.expireTime ? Date.parse(minted.expireTime) : Number.NaN;
    const refreshAt = Number.isFinite(expiresAt) ? expiresAt - TOKEN_REFRESH_MARGIN_MS : now();
    cache.set(organizationId, { token: minted.accessToken, refreshAt });
    return minted.accessToken;
  };
}

/** The production KEK providers. */
export function createOrganizationKekProviders(options: OrganizationKekProviderOptions = {}): OrganizationKekProviders {
  const gcpTokens = organizationGcpKmsTokenSource(options);
  return {
    'aws-kms': regionalAwsKmsKekProvider(options.createAwsKmsClient ?? defaultAwsKmsClient),
    'gcp-kms': gcpKmsKekProvider({ accessToken: gcpTokens, fetch: options.fetch }),
  };
}

interface RegistryState {
  providers: OrganizationKekProviders | null;
  services: WeakMap<Sql, OrganizationKeyService>;
  /** Shared by every service: a transaction handle must not start with a cold DEK cache. */
  cache?: OrganizationKeyCache;
}

const registry = pinModuleState<RegistryState>('@papercusp/operator-core.organization-key-registry', () => ({
  providers: null,
  services: new WeakMap(),
  cache: createOrganizationKeyCache(),
}));

/**
 * The key service for this database handle. Each handle (a transaction handle included) gets its own
 * service, because the service reads custody through the handle it was built with; all of them share
 * the one process cache.
 */
export function organizationKeyService(sql: Sql): OrganizationKeyService {
  let service = registry.services.get(sql);
  if (!service) {
    registry.providers ??= createOrganizationKekProviders();
    registry.cache ??= createOrganizationKeyCache();
    service = createOrganizationKeyService({ sql, providers: registry.providers, cache: registry.cache });
    registry.services.set(sql, service);
  }
  return service;
}

/**
 * Replace the providers every later organizationKeyService call uses, and drop the existing services
 * and the shared cache (its plaintext DEKs are zeroed). For tests and local journeys that run against
 * `test-kms`. Pass null to restore the production providers.
 */
export function useOrganizationKekProviders(providers: OrganizationKekProviders | null): void {
  registry.providers = providers;
  registry.services = new WeakMap();
  registry.cache?.clear();
  registry.cache = createOrganizationKeyCache();
}

export type OrganizationKeyCustodyState = 'enabled' | 'revoked' | 'shredded';

/**
 * The organization's key custody state, or null when the organization has not provisioned a customer
 * key. Writers seal under the organization key whenever custody exists, whatever its state: a revoked
 * or shredded organization then fails closed instead of falling back to plaintext.
 */
export async function organizationKeyCustodyState(sql: Sql, organizationId: string): Promise<OrganizationKeyCustodyState | null> {
  const rows = await sql<{ state: OrganizationKeyCustodyState }[]>`
    SELECT state FROM harness_shared.organization_key_custody WHERE organization_id = ${organizationId}`;
  return rows[0]?.state ?? null;
}
