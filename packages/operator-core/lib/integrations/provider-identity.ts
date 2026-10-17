/**
 * The connected account behind a provider credential, read from the package's declared identity
 * endpoint (`oauth.identity`: url, idField, displayNameField, optional POST body).
 *
 * One implementation serves both ways a provider is connected:
 *   - the OAuth callback, with the fresh access token (connection-lifecycle.ts, D-006);
 *   - a pasted credential such as a personal access token, with the stored value
 *     (provider-credentials.ts; plan cupboard-distributable-integrations-2026-10-10 D-016).
 *
 * The host makes the request. Provider code never sees the secret, and the request only goes to an
 * https endpoint on a host the package declares in `egressHosts`. Error messages are named codes
 * (`<errorPrefix>_identity_<status>`), never the secret or the response body.
 */
import { providerEgressAllows, type ProviderDescriptor } from '@papercusp/plugin-sdk';
import { normalizeOAuthUserAgent } from './oauth-client-registration';
import { assertProviderOwnerUnblocked } from './provider-registry';

export interface ProviderAccountIdentity {
  providerAccountId: string;
  displayName?: string;
}

function readJsonPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Account identity from the descriptor's identity endpoint, fetched by the host with `secret` as the bearer. */
export async function fetchProviderIdentity(
  descriptor: Pick<ProviderDescriptor, 'oauth' | 'egressHosts' | 'verification'> & Partial<Pick<ProviderDescriptor, 'id'>>,
  secret: string,
  errorPrefix: string,
  fetchImpl: typeof fetch = fetch,
  userAgent?: string | null,
): Promise<ProviderAccountIdentity> {
  assertProviderOwnerUnblocked(descriptor, 'oauth.identity');
  const identification = normalizeOAuthUserAgent(userAgent);
  if (descriptor.oauth?.userAgentRequired && !identification) throw new Error(`${errorPrefix}_user_agent_required`);
  const identity = descriptor.oauth?.identity;
  if (!identity) throw new Error(`${errorPrefix}_identity_endpoint_missing`);
  const url = new URL(identity.url);
  if (url.protocol !== 'https:' || !providerEgressAllows(descriptor.egressHosts, url.hostname)) {
    throw new Error(`${errorPrefix}_identity_endpoint_not_allowed`);
  }
  // POST + JSON body for identity endpoints that only answer a request body (a GraphQL API).
  const post = identity.method === 'POST';
  const response = await fetchImpl(url, {
    method: post ? 'POST' : 'GET',
    redirect: 'manual',
    headers: {
      authorization: `Bearer ${secret}`,
      accept: 'application/json',
      ...(identification ? { 'user-agent': identification } : {}),
      ...(post ? { 'content-type': 'application/json' } : {}),
    },
    ...(post && identity.body !== undefined ? { body: identity.body } : {}),
  });
  if (!response.ok) throw new Error(`${errorPrefix}_identity_${response.status}`);
  const body = (await response.json()) as unknown;
  const id = readJsonPath(body, identity.idField);
  if ((typeof id !== 'string' && typeof id !== 'number') || String(id).trim() === '') {
    throw new Error(`${errorPrefix}_identity_unavailable`);
  }
  const display = identity.displayNameField ? readJsonPath(body, identity.displayNameField) : undefined;
  return {
    providerAccountId: String(id).trim(),
    ...(typeof display === 'string' && display.trim() ? { displayName: display.trim() } : {}),
  };
}
