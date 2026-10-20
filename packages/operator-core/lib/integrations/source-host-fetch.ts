/**
 * The production `host.fetch` for one provider, resolved per SOURCE (plan
 * generalized-integrations-google-migration-cupboard-workflows-2026-10-05,
 * D-014.4).
 *
 * The connector sync driver and outbound capability dispatch both reach a
 * provider's API through this one function, so there is exactly one token path:
 * the access token injected is the one stored for the named source's own
 * account, refreshed through the connection lifecycle. Nothing else in the host
 * mints provider credentials for a provider call.
 */
import type postgres from 'postgres';
import { normalizeProviderInstanceOrigin, type HostFetch } from '@papercusp/plugin-sdk';
import { getExternalTriggerSource, sourceTokenHarness } from '../external-triggers/source-store';
import { connectionAccessToken, descriptorOAuthPlugin } from './connection-lifecycle';
import { createHostFetch, HostFetchError } from './host-fetch';
import { providerOAuthUserAgent } from './oauth-client-registration';
import {
  providerCredentialSession,
  providerSetupStoreKey,
  readProviderCredentialValue,
  readProviderPrincipalCredentialValue,
} from './provider-credentials';
import { providerRegistry, type ProviderRegistry } from './provider-registry';

export interface SourceHostFetchOptions {
  providerId: string;
  workspaceId: string;
  /** Install slug whose token store holds the source credentials. */
  harness: string;
  registry?: ProviderRegistry;
  fetchImpl?: typeof fetch;
  /**
   * Restrict the fetch to these source ids. Outbound dispatch binds it to the
   * one source the verb selected, so a provider cannot spend another account of
   * the same provider (another user's, in a shared workspace) by naming its id.
   * Omitted only by the sync driver, which syncs every source of the provider.
   */
  sourceIds?: readonly string[];
  /** Error to throw when the source's account must be reconnected. */
  reconnectRequired?: (reason: string) => Error;
  /**
   * The workspace user this fetch acts for (a live search, cupboard-distributable-integrations
   * D-026). Hosts a per-person setup field claims then carry that user's own stored value, and a
   * user with none gets `principal-credential-missing` instead of the source's access. Omitted by
   * the sync driver and outbound dispatch, which act for the source.
   */
  principalUserId?: string;
}

export function createSourceHostFetch(sql: postgres.Sql, opts: SourceHostFetchOptions): HostFetch {
  // Every source credential is a `provider:<group>:<field>` ref whose adapter the
  // registry derives on demand (connection-lifecycle awaits plugin discovery), so a
  // process that never served an OAuth route still resolves it (WI-10006541).
  const allowed = opts.sourceIds ? new Set(opts.sourceIds) : null;
  const registry = opts.registry ?? providerRegistry();
  return createHostFetch(opts.providerId, {
    registry,
    fetchImpl: opts.fetchImpl,
    async credentialSession(source) {
      const entry = registry.get(source.providerId);
      if (!entry || source.ownCredential) throw new HostFetchError('credential-unavailable', 'host.fetch: source does not own the pasted session');
      const row = await getExternalTriggerSource(sql, opts.workspaceId, source.sourceId);
      if (!row || row.credentialRef !== providerSetupStoreKey(source.providerId)) {
        throw new HostFetchError('credential-unavailable', 'host.fetch: source does not own the pasted session');
      }
      const session = await providerCredentialSession(entry.descriptor, sourceTokenHarness(row.config, opts.harness), { fetchImpl: opts.fetchImpl });
      if (source.config?.accountId !== session.identity.providerAccountId) {
        throw new HostFetchError('credential-unavailable', 'host.fetch: reconnect source to its current session account');
      }
      return session;
    },
    async userAgent(source) {
      const descriptor = registry.get(source.providerId)?.descriptor;
      return descriptor ? providerOAuthUserAgent(descriptor, registry.list().map((entry) => entry.descriptor), descriptor.oauth?.instance ? source.config?.connectionOrigin : undefined) : null;
    },
    // Owner-pasted setup credentials live in the same install's token store (P-001).
    async pastedCredential(key) {
      const registered = registry.get(opts.providerId);
      return registered ? readProviderCredentialValue(registered.descriptor, opts.harness, key) : null;
    },
    ...(opts.principalUserId
      ? {
        async principalCredential(key: string) {
          const registered = registry.get(opts.providerId);
          return registered
            ? readProviderPrincipalCredentialValue(registered.descriptor, opts.harness, opts.principalUserId!, key)
            : null;
        },
      }
      : {}),
    async resolveSource(sourceId) {
      if (allowed && !allowed.has(sourceId)) return null;
      const row = await getExternalTriggerSource(sql, opts.workspaceId, sourceId);
      if (!row) return null;
      const descriptor = registry.get(row.kind)?.descriptor;
      if (descriptor?.oauth?.instance) {
        const origin = normalizeProviderInstanceOrigin(row.config?.connectionOrigin);
        if (!origin || !row.credentialRef?.startsWith(`${descriptorOAuthPlugin(descriptor, origin)}:`)) {
          throw new HostFetchError('token-unavailable', 'host.fetch: instance origin does not match the source credential');
        }
      }
      // A source whose credential ref is not the install's pasted-credential store holds its own
      // account credential (an OAuth connection), which host.fetch prefers (WI-6554700010008555).
      const ownCredential = row.credentialRef != null && row.credentialRef !== providerSetupStoreKey(row.kind);
      return { sourceId: row.id, providerId: row.kind, ownCredential, config: row.config };
    },
    async accessToken(resolved) {
      const row = await getExternalTriggerSource(sql, opts.workspaceId, resolved.sourceId);
      const token = await connectionAccessToken(sql, {
        workspaceId: opts.workspaceId,
        harness: opts.harness,
        credentialRef: row?.credentialRef ?? null,
      });
      if ('reconnectRequired' in token) {
        throw (
          opts.reconnectRequired?.(token.reason) ??
          new HostFetchError(
            'token-unavailable',
            `host.fetch: source "${resolved.sourceId}" must be reconnected (${token.reason})`,
          )
        );
      }
      return token.accessToken;
    },
  });
}
