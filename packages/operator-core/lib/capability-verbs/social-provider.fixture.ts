/**
 * Installed social provider packages, for the social:* verb suites
 * (provider-adapters-to-packages-2026-10-11 P-002).
 *
 * The social write verbs no longer look up an in-app adapter: they dispatch
 * through `invokeOutboundProvider` to whichever installed provider package
 * serves the post's platform. A test therefore "installs" a package the way the
 * Cupboard does — a descriptor plus an adapter registered in a provider
 * registry — and hands that registry to the verb as its `deps`.
 *
 * Every adapter records the invoke it received and answers with a well-formed
 * SDK result. The host fetch the dispatcher would build is replaced by one that
 * counts how often it was built and throws if anything calls it, so a suite can
 * state a refusal as a measurement: "no package was invoked and no provider
 * request was prepared".
 */
import {
  PROVIDER_SOCIAL_DELETE_CAPABILITY,
  PROVIDER_SOCIAL_POST_CAPABILITY,
  PROVIDER_SOCIAL_REPLY_CAPABILITY,
  type HostFetch,
  type ProviderAdapter,
  type ProviderDescriptor,
  type ProviderInvokeRequest,
} from '@papercusp/plugin-sdk';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createProviderRegistry, providerRegistry, type ProviderRegistry } from '../integrations/provider-registry';
import type { OutboundDispatchDeps } from './provider-dispatch';

/** Every social write capability a package can declare. */
export const ALL_SOCIAL_CAPABILITIES: readonly string[] = [
  PROVIDER_SOCIAL_POST_CAPABILITY,
  PROVIDER_SOCIAL_REPLY_CAPABILITY,
  PROVIDER_SOCIAL_DELETE_CAPABILITY,
];

export interface SocialPackageSpec {
  /** The platform id, which IS the provider id. */
  platform: string;
  /** Declared capabilities. Defaults to all three social write capabilities. */
  capabilities?: readonly string[];
  verification?: ProviderDescriptor['verification'];
  rateBudget?: ProviderDescriptor['rateBudget'];
  /** The package's answer. Defaults to a well-formed result for the capability. */
  respond?: (request: ProviderInvokeRequest) => Record<string, unknown>;
}

export interface InstalledSocialPackages {
  /** Pass as the verb's `deps`. */
  deps: OutboundDispatchDeps & { registry: ProviderRegistry };
  /** Every adapter invoke, in order. */
  invokes: Array<{ provider: string; request: ProviderInvokeRequest }>;
  /** How many host fetches the dispatcher built — one per invoke that reached dispatch. */
  hostFetchesBuilt: number;
}

function defaultResult(request: ProviderInvokeRequest): Record<string, unknown> {
  if (request.capability === PROVIDER_SOCIAL_DELETE_CAPABILITY) return { deleted: true };
  return { externalId: '110000', url: 'https://example.test/110000' };
}

/** Install one provider package per spec into a fresh registry. */
export async function installSocialPackages(
  specs: readonly SocialPackageSpec[],
  registry: ProviderRegistry = createProviderRegistry(),
): Promise<InstalledSocialPackages> {
  const installed: InstalledSocialPackages = {
    deps: {
      registry,
      hostFetchFor: () => {
        installed.hostFetchesBuilt += 1;
        const fetch: HostFetch = async () => {
          throw new Error('social fixture packages never reach the network');
        };
        return fetch;
      },
    },
    invokes: [],
    hostFetchesBuilt: 0,
  };

  for (const spec of specs) {
    const descriptor: ProviderDescriptor = {
      id: spec.platform,
      contractVersion: 1,
      datatypes: ['social-post'],
      capabilities: [...(spec.capabilities ?? ALL_SOCIAL_CAPABILITIES)],
      egressHosts: [`${spec.platform}.example.test`],
      ...(spec.rateBudget ? { rateBudget: spec.rateBudget } : {}),
      verification: spec.verification ?? {
        verifiedAt: '2026-10-16', sources: ['https://example.test/contract'],
        capabilities: Object.fromEntries((spec.capabilities ?? ALL_SOCIAL_CAPABILITIES).map((capability) => [capability, '2026-10-16'])),
      },
    };
    const adapter: ProviderAdapter = {
      describe: () => descriptor,
      syncPage: async () => ({ records: [], nextCursor: null, hasMore: false }),
      invoke: async (request) => {
        installed.invokes.push({ provider: spec.platform, request });
        return (spec.respond ?? defaultResult)(request);
      },
    };
    await registry.register({ descriptor, adapter, pluginName: `${spec.platform}-provider` });
  }
  return installed;
}

/** Pure verb tests use installed descriptors too; unverified is a synthetic package,
 * so verifying another vendor never silently changes the refusal under test. */
export async function installDefaultSocialPackages(): Promise<void> {
  const registry = providerRegistry();
  registry.clear();
  for (const descriptor of bundledSocialProviderDescriptors()) {
    const name = descriptor.id;
    await registry.register({ descriptor, adapter: {
      describe: () => descriptor,
      syncPage: async () => ({ records: [], nextCursor: null, hasMore: false }),
      invoke: async () => { throw new Error('pure fixture must not invoke a provider'); },
    }, pluginName: name });
  }
  await installSocialPackages([{ platform: 'unverified-social', verification: { verifiedAt: null, sources: [] } }], registry);
}

/** The request arguments each invoke carried, typed as the verb's request shape. */
export function invokedArgs<T>(installed: InstalledSocialPackages): T[] {
  return installed.invokes.map(({ request }) => request.args as unknown as T);
}

/** Current package descriptors are the acceptance inputs, including unload/additions. */
export function bundledSocialProviderDescriptors(): ProviderDescriptor[] {
  const directory = new URL('../../../../libs/papercusp/plugins/', import.meta.url);
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = new URL(entry.name + '/papercusp.json', directory);
      if (!existsSync(path)) return [];
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      const descriptor = manifest.provider as ProviderDescriptor | undefined;
      return descriptor?.datatypes.includes('social-post') ? [descriptor] : [];
    });
}
