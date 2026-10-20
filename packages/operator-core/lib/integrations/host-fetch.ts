/**
 * Host-mediated fetch for integration providers (generalized-integrations
 * D-006 / P-001).
 *
 * Providers never receive tokens. They call `host.fetch({ source, request })`;
 * the host resolves the source's provider, refuses any URL outside the
 * provider's declared egress hosts, injects the access token for exactly that
 * source's account, and returns the response. The same function backs
 * in-process `js` providers and (via the daemon bridge) sandboxed daemon
 * providers.
 */
import {
  providerCredentialForHost,
  providerCredentialHeaderValue,
  providerSourceEgressAllows,
  providerPrincipalCredentialForHost,
  type HostFetch,
  type HostFetchRequest,
  type HostFetchResponse,
  type ProviderOAuthResourceToken,
} from '@papercusp/plugin-sdk';
import { assertProviderOwnerUnblocked, type ProviderRegistry } from './provider-registry';
import { serviceCredentialForHost, serviceCredentialResolver } from './service-credentials';
import { normalizeOAuthUserAgent } from './oauth-client-registration';

export type HostFetchErrorCode =
  | 'unknown-source'
  | 'source-provider-mismatch'
  | 'egress-denied'
  | 'insecure-url'
  | 'caller-authorization-header'
  | 'user-agent-required'
  | 'token-unavailable'
  | 'service-credential-unavailable'
  | 'credential-unavailable'
  | 'principal-credential-missing'
  | 'resource-token-unavailable'
  | 'credential-endpoint-private';

export class HostFetchError extends Error {
  constructor(
    readonly code: HostFetchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HostFetchError';
  }
}

export interface HostFetchSource {
  sourceId: string;
  providerId: string;
  /**
   * True when the source carries its OWN account credential (an OAuth connection), not the
   * install's pasted one. On a host a pasted credential claims, such a source is sent its own
   * token and falls back to the pasted value only when it has none (WI-6554700010008555).
   */
  ownCredential?: boolean;
  /** Persisted source config; only the host can select the resource credential. */
  config?: Record<string, unknown>;
}

export interface HostFetchDeps {
  registry: ProviderRegistry;
  /** Resolves a source id to its owning provider; null when unknown. */
  resolveSource(sourceId: string): Promise<HostFetchSource | null>;
  /** Returns a fresh access token for exactly this source's account; null when the source needs none. */
  accessToken(source: HostFetchSource): Promise<string | null>;
  /** Public application identification from this source's host-held OAuth registration. */
  userAgent?(source: HostFetchSource): Promise<string | null>;
  /**
   * Mints the host-held service credential registered under `ref` (D-018.1).
   * Defaults to the service-credentials registry.
   */
  serviceAccessToken?(ref: string): Promise<string>;
  /**
   * The owner-pasted value of the provider's `setup.credentials` field `key`, or null when it is
   * not configured (cupboard-distributable-integrations P-001). Required for a provider whose
   * descriptor injects a pasted credential; the value never reaches provider code.
   */
  pastedCredential?(key: string): Promise<string | null>;
  /**
   * Set only on a fetch bound to one person (a live search, cupboard-distributable-integrations
   * D-026): that person's own value of the per-person field `key`, or null when they stored none.
   * A host a per-person field claims then carries their value, ahead of every source credential,
   * and the call fails with `principal-credential-missing` rather than fall back to the source's
   * broader access. Without this dep per-person fields are never consulted.
   */
  principalCredential?(key: string): Promise<string | null>;
  /** Session exchange stays host-side, including every credential-bearing response. */
  credentialSession?(source: HostFetchSource): Promise<{ accessToken: string; secrets: string[] }>;
  fetchImpl?: typeof fetch;
}

async function defaultServiceAccessToken(ref: string): Promise<string> {
  const resolver = serviceCredentialResolver(ref);
  if (!resolver) throw new Error(`service credential "${ref}" is not registered`);
  return resolver.accessToken();
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authorization']);

function field(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) =>
    current !== null && typeof current === 'object' && Object.hasOwn(current, key)
      ? (current as Record<string, unknown>)[key] : undefined, value);
}

/** This response contains credentials, so it stays entirely inside the host. No cache or retry. */
async function resourceAccessToken(
  exchange: ProviderOAuthResourceToken, source: HostFetchSource, accountAuthorization: string | null, doFetch: typeof fetch, userAgent: string | null,
): Promise<string> {
  const id = source.config?.[exchange.configKey];
  const unavailable = (reason: string) => new HostFetchError('resource-token-unavailable', `host.fetch: resource credential ${reason}`);
  if (typeof id !== 'string' || !id.trim()) throw unavailable(`needs source config ${exchange.configKey}`);
  if (!accountAuthorization) throw unavailable('needs the connected account');
  const endpoint = new URL(exchange.url);
  let url = endpoint;
  const seen = new Set<string>();
  for (let page = 0; page < 20; page += 1) {
    if (url.origin !== endpoint.origin || url.pathname !== endpoint.pathname || url.username || url.password || seen.has(url.href)) {
      throw unavailable('has an invalid pagination URL');
    }
    seen.add(url.href);
    let response: Response;
    try { response = await doFetch(url, { headers: { authorization: accountAuthorization, ...(userAgent ? { 'user-agent': userAgent } : {}) }, redirect: 'manual' }); }
    catch { throw Object.assign(unavailable('exchange network request failed'), { kind: 'transient' }); }
    if (!response.ok) {
      // Never echo the body, URL query or account/resource token into an error.
      const error = unavailable(`exchange returned HTTP ${response.status}`);
      throw Object.assign(error, response.status === 429
        ? { kind: 'rate-limited', retryAfterSeconds: Number(response.headers.get('retry-after')) || 30 }
        : { kind: response.status === 401 || response.status === 403 ? 'auth' : 'transient' });
    }
    let body: unknown;
    try { body = await response.json(); } catch { throw unavailable('exchange returned invalid JSON'); }
    const rows = field(body, exchange.collectionField);
    if (!Array.isArray(rows)) throw unavailable('exchange returned no resource collection');
    const row = rows.find((candidate) => field(candidate, exchange.idField) === id);
    if (row) {
      if (exchange.permissions) {
        const permissions = field(row, exchange.permissions.field);
        if (!Array.isArray(permissions) || !exchange.permissions.required.every((permission) => permissions.includes(permission))) {
          throw Object.assign(unavailable('does not grant the required resource permissions'), { kind: 'auth' });
        }
      }
      const token = field(row, exchange.tokenField);
      if (typeof token !== 'string' || !token.trim()) throw unavailable('exchange returned no resource token');
      return token;
    }
    const next = exchange.nextUrlField ? field(body, exchange.nextUrlField) : null;
    if (!next) throw Object.assign(unavailable('does not include the configured resource'), { kind: 'auth' });
    if (typeof next !== 'string') throw unavailable('has an invalid pagination URL');
    try { url = new URL(next); } catch { throw unavailable('has an invalid pagination URL'); }
  }
  throw unavailable('exceeded the resource pagination limit');
}

/** A vendor may echo a token. Keep both raw bytes and JSON-escaped echoes inside the host. */
function redactCredentials(input: Buffer, secrets: string[]): Buffer {
  let result = input;
  for (const value of new Set(secrets.flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1)]))) {
    if (!value) continue;
    const token = Buffer.from(value);
    let offset = 0;
    let found = result.indexOf(token, offset);
    if (found < 0) continue;
    const pieces: Buffer[] = [];
    while (found >= 0) {
      pieces.push(result.subarray(offset, found), Buffer.from('[redacted]'));
      offset = found + token.length;
      found = result.indexOf(token, offset);
    }
    pieces.push(result.subarray(offset));
    result = Buffer.concat(pieces);
  }
  return result;
}

/**
 * Build a host fetch bound to ONE provider. A provider can only fetch for
 * sources it owns, so a hostile provider cannot borrow another provider's
 * account by naming a foreign source id.
 */
export function createHostFetch(providerId: string, deps: HostFetchDeps): HostFetch {
  const doFetch = deps.fetchImpl ?? fetch;
  return async ({ source, request }: { source: string; request: HostFetchRequest }): Promise<HostFetchResponse> => {
    const resolved = await deps.resolveSource(source);
    if (!resolved) throw new HostFetchError('unknown-source', `host.fetch: unknown source "${source}"`);
    if (resolved.providerId !== providerId) {
      throw new HostFetchError(
        'source-provider-mismatch',
        `host.fetch: source "${source}" belongs to provider "${resolved.providerId}", not "${providerId}"`,
      );
    }
    const registered = deps.registry.get(providerId);
    if (!registered) throw new HostFetchError('unknown-source', `host.fetch: provider "${providerId}" is not registered`);
    assertProviderOwnerUnblocked(registered.descriptor, 'host.fetch');
    // Credential refresh and resource-token selection await host work. Recheck at
    // each transport boundary so an unload or newly blocked replacement cannot
    // inherit the request authorized by this captured descriptor.
    const guardedFetch: typeof fetch = (...args) => {
      const current = deps.registry.get(providerId);
      if (current) assertProviderOwnerUnblocked(current.descriptor, 'host.fetch');
      if (current !== registered) throw new HostFetchError('unknown-source', `host.fetch: provider "${providerId}" changed before dispatch`);
      return doFetch(...args);
    };

    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      throw new HostFetchError('egress-denied', `host.fetch: invalid URL "${request.url}"`);
    }
    if (url.protocol !== 'https:') {
      throw new HostFetchError('insecure-url', `host.fetch: only https URLs are allowed (got ${url.protocol})`);
    }
    if (url.username || url.password) {
      throw new HostFetchError('egress-denied', 'host.fetch: URLs with embedded credentials are refused');
    }
    if (!providerSourceEgressAllows(registered.descriptor, url, resolved.config)) {
      throw new HostFetchError(
        'egress-denied',
        `host.fetch: ${url.hostname} is not in provider "${providerId}" egressHosts`,
      );
    }
    const resourceToken = registered.descriptor.oauth?.resourceToken;
    const session = registered.descriptor.setup?.session;
    for (const endpointUrl of session ? [session.url, session.refreshUrl] : []) {
      const endpoint = new URL(endpointUrl);
      if (url.origin === endpoint.origin && url.pathname === endpoint.pathname) {
        throw new HostFetchError('credential-endpoint-private', 'host.fetch: session credential endpoints are host-only');
      }
    }
    if (resourceToken) {
      const endpoint = new URL(resourceToken.url);
      if (url.origin === endpoint.origin && url.pathname === endpoint.pathname) {
        throw new HostFetchError('credential-endpoint-private', 'host.fetch: the resource credential endpoint is host-only');
      }
    }

    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      const lower = name.toLowerCase();
      if (['authorization', 'api-key', 'x-api-key'].includes(lower)) {
        throw new HostFetchError(
          'caller-authorization-header',
          'host.fetch: providers may not set authentication headers; the host injects the source credential',
        );
      }
      if (!HOP_BY_HOP.has(lower)) headers.set(name, value);
    }
    const userAgent = normalizeOAuthUserAgent(await deps.userAgent?.(resolved));
    if (registered.descriptor.oauth?.userAgentRequired && !userAgent) {
      throw new HostFetchError('user-agent-required', 'host.fetch: add your app’s User-Agent to its OAuth registration');
    }
    if (userAgent) headers.set('user-agent', userAgent);
    // On a call made for one person, a host a per-person field claims carries that person's own
    // value, so the vendor answers with exactly what they may see (D-026).
    const principal = deps.principalCredential
      ? providerPrincipalCredentialForHost(registered.descriptor, url.hostname)
      : null;
    const principalValue = principal ? await deps.principalCredential!(principal.key) : null;
    if (principal && !principalValue) {
      throw new HostFetchError(
        'principal-credential-missing',
        `host.fetch: "${principal.label}" for provider "${providerId}" is not set up for you; add your own on the Integrations page`,
      );
    }
    // A host declared under serviceCredentials gets the host-held service
    // identity, never the source's user token (D-018.1).
    const service = principal ? null : serviceCredentialForHost(registered.descriptor.serviceCredentials, url.hostname);
    // A host a pasted credential claims gets that value (P-001); the descriptor validator keeps
    // pasted and service credentials from claiming the same host.
    const pasted = principal || service ? null : providerCredentialForHost(registered.descriptor, url.hostname);
    // A provider may offer a pasted credential as an ALTERNATIVE to OAuth (Asana's personal access
    // token). Declaring one must not cut an existing OAuth source off from its own account: that
    // source is sent its own token, and the pasted value is only its fallback.
    const ownToken = pasted && resolved.ownCredential ? await deps.accessToken(resolved) : null;
    const secretValues: string[] = [];
    const injectPasted = (field: NonNullable<typeof pasted>, value: string) => {
      const auth = field.auth ?? { header: 'authorization', scheme: 'bearer' };
      headers.set(auth.header, providerCredentialHeaderValue(auth.scheme, value));
      secretValues.push(value);
    };
    if (session?.hosts.includes(url.hostname)) {
      if (!deps.credentialSession) throw new HostFetchError('credential-unavailable', 'host.fetch: session resolver unavailable');
      const credential = await deps.credentialSession(resolved);
      headers.set('authorization', `Bearer ${credential.accessToken}`);
      secretValues.push(...credential.secrets);
    } else if (principalValue) {
      injectPasted(principal!, principalValue);
    } else if (ownToken) {
      headers.set('authorization', `Bearer ${ownToken}`);
    } else if (pasted) {
      const value = deps.pastedCredential ? await deps.pastedCredential(pasted.key) : null;
      if (!value) {
        throw new HostFetchError(
          'credential-unavailable',
          `host.fetch: "${pasted.label}" for provider "${providerId}" is not set up; paste it on the Integrations page`,
        );
      }
      injectPasted(pasted, value);
    } else if (service) {
      let serviceToken: string;
      try {
        serviceToken = await (deps.serviceAccessToken ?? defaultServiceAccessToken)(service.ref);
      } catch (error) {
        throw new HostFetchError(
          'service-credential-unavailable',
          `host.fetch: service credential "${service.ref}" is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      headers.set('authorization', `Bearer ${serviceToken}`);
    } else {
      const token = await deps.accessToken(resolved);
      if (registered.descriptor.oauth && !token) {
        throw new HostFetchError('token-unavailable', `host.fetch: no access token for source "${source}"`);
      }
      if (token) headers.set('authorization', `Bearer ${token}`);
    }

    const accountAuthorization = headers.get('authorization');
    if (accountAuthorization?.startsWith('Bearer ')) secretValues.push(accountAuthorization.slice(7));
    if (resourceToken?.hosts.includes(url.hostname)) {
      const token = await resourceAccessToken(resourceToken, resolved, accountAuthorization, guardedFetch, userAgent);
      secretValues.push(token);
      headers.set('authorization', `Bearer ${token}`);
    }

    const body =
      request.body === undefined
        ? undefined
        : request.bodyEncoding === 'base64'
          ? Buffer.from(request.body, 'base64')
          : request.body;
    const response = await guardedFetch(url, {
      method: request.method ?? 'GET',
      headers,
      body,
      redirect: 'manual',
    });

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      if (name.toLowerCase() !== 'set-cookie' && name.toLowerCase() !== 'content-length') {
        responseHeaders[name] = redactCredentials(Buffer.from(value), secretValues).toString('utf8');
      }
    });
    const contentType = response.headers.get('content-type') ?? '';
    const textual = /^(text\/|application\/(json|xml|[a-z.+-]*\+json|[a-z.+-]*\+xml|x-www-form-urlencoded))/i.test(contentType) || contentType === '';
    const buffer = redactCredentials(Buffer.from(await response.arrayBuffer()), secretValues);
    return textual
      ? { status: response.status, headers: responseHeaders, body: buffer.toString('utf8'), bodyEncoding: 'utf8' }
      : { status: response.status, headers: responseHeaders, body: buffer.toString('base64'), bodyEncoding: 'base64' };
  };
}
