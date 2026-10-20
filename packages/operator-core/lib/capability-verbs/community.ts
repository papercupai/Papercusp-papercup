/**
 * Provider-neutral community presence (P-005, D-035): the online count + invite a harness's
 * community badge shows. A provider package that declares `community.presence` (Discord first)
 * reads it through its own source; this module names no provider.
 */
import type postgres from 'postgres';
import { pinModuleState } from '@papercusp/module-singleton';
import { listOwnedExternalTriggerSources, sourceTokenHarness } from '../external-triggers/source-store';
import { readyProviderRegistry, type ProviderRegistry } from '../integrations/provider-registry';
import { invokeOutboundProvider, OUTBOUND_CAPABILITIES, type OutboundDispatchDeps } from './provider-dispatch';

export interface CommunityPresence {
  providerId: string;
  displayName: string;
  /** Null when the community's public widget is off or unreadable. */
  presenceCount: number | null;
  name: string | null;
  inviteUrl: string | null;
}

const TTL_MS = 5 * 60 * 1000;
// Pinned so a split module record cannot give each copy its own cache (and double vendor reads).
const { cache } = pinModuleState('@papercusp/operator-core.communityPresenceCache',
  () => ({ cache: new Map<string, { at: number; value: CommunityPresence | null }>() }));

/** Test seam: forget cached reads. */
export function resetCommunityPresenceCache(): void {
  cache.clear();
}

/**
 * The owner's community presence for `harnessSlug`. Among the owner's sources whose provider
 * offers `community.presence`, the one filed under this harness wins; with no such source, a
 * single owned source is used. Several candidates and no harness match return null rather than
 * showing a community the owner did not pick. Cached 5 minutes per harness to respect vendor limits.
 */
export async function readCommunityPresence(sql: postgres.Sql, params: { workspaceId: string; userId: string; harnessSlug: string },
  deps: OutboundDispatchDeps & { now?: () => number } = {}): Promise<CommunityPresence | null> {
  const now = (deps.now ?? Date.now)();
  const key = `${params.workspaceId}:${params.userId}:${params.harnessSlug}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  const registry: ProviderRegistry = deps.registry ?? (await readyProviderRegistry());
  const owned = await listOwnedExternalTriggerSources(sql, params.workspaceId, params.userId);
  const candidates = owned.flatMap((source) => {
    const entry = registry.get(source.kind);
    if (!entry || !entry.descriptor.capabilities.includes(OUTBOUND_CAPABILITIES.communityPresence)) return [];
    if (source.status === 'disabled' || source.status === 'error') return [];
    return [{ source, entry, installSlug: sourceTokenHarness(source.config, params.harnessSlug) }];
  });
  const filed = candidates.filter((c) => c.installSlug === params.harnessSlug);
  const chosen = filed.length === 1 ? filed[0] : filed.length === 0 && candidates.length === 1 ? candidates[0] : null;
  let value: CommunityPresence | null = null;
  if (chosen) {
    const provider = { kind: 'registered' as const, id: chosen.entry.descriptor.id, entry: chosen.entry };
    // `notification` routes the call through the verified-provider recheck in invokeOutboundProvider.
    const result = await invokeOutboundProvider(sql, { source: chosen.source, provider, datatype: 'notification',
      installSlug: chosen.installSlug, userId: params.userId }, OUTBOUND_CAPABILITIES.communityPresence, {}, deps).catch(() => null);
    if (result) {
      value = {
        providerId: provider.id,
        displayName: chosen.entry.descriptor.displayName ?? provider.id,
        presenceCount: Number.isSafeInteger(result.presenceCount) && (result.presenceCount as number) >= 0 ? result.presenceCount as number : null,
        name: typeof result.name === 'string' ? result.name : null,
        inviteUrl: typeof result.inviteUrl === 'string' && result.inviteUrl.startsWith('https://') ? result.inviteUrl : null,
      };
    }
  }
  cache.set(key, { at: now, value });
  return value;
}
