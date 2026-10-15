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
import type { HostFetch } from '@papercusp/plugin-sdk';
import { getExternalTriggerSource } from '../external-triggers/source-store';
import { ensureBuiltinConnectionAdapters } from './builtin-connection-adapters';
import { connectionAccessToken } from './connection-lifecycle';
import { createHostFetch, HostFetchError } from './host-fetch';
import {
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
  // First-party sources (Google, Facebook) carry `<plugin>:<field>` credential
  // refs whose token store is reached through a registered connection adapter.
  // Registering here, on the one production token path, means a process that
  // has never served an OAuth route still resolves those tokens (WI-10006541:
  // the connector driver failed every Google source with "no access token").
  ensureBuiltinConnectionAdapters();
  const allowed = opts.sourceIds ? new Set(opts.sourceIds) : null;
  const registry = opts.registry ?? providerRegistry();
  return createHostFetch(opts.providerId, {
    registry,
    fetchImpl: opts.fetchImpl,
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
