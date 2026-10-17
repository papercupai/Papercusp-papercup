/**
 * Operator-core integration provider registry (generalized-integrations-
 * google-migration-cupboard-workflows-2026-10-05, D-006 / P-001).
 *
 * Holds every loaded provider (first-party `js` and, later, sandboxed daemon
 * providers) keyed by descriptor id. Registration refuses duplicate ids,
 * unsupported contract versions and invalid descriptors with named errors;
 * unregistration is part of the plugin load/unload lifecycle.
 *
 * The registry is module state shared by every loader seam, so it is pinned
 * through `pinModuleState` (CLAUDE.md "Shared-lib singletons").
 */
import { pinModuleState } from '@papercusp/module-singleton';
import { withBoundedTimeout } from '../bounded-timeout';
import {
  isProviderAdapter,
  providerCapabilityVerificationIssue,
  validateProviderDescriptor,
  type ProviderAdapter,
  type ProviderDescriptor,
} from '@papercusp/plugin-sdk';

export type ProviderRuntime = 'js' | 'daemon';

export interface RegisteredProvider {
  descriptor: ProviderDescriptor;
  adapter: ProviderAdapter;
  /** Plugin that owns this provider; used to unregister on unload. */
  pluginName: string;
  runtime: ProviderRuntime;
  registeredAt: number;
}

export type ProviderRegistrationErrorCode =
  | 'duplicate-provider'
  | 'unsupported-contract-version'
  | 'invalid-descriptor'
  | 'invalid-adapter'
  | 'descriptor-mismatch';

export class ProviderRegistrationError extends Error {
  constructor(
    readonly code: ProviderRegistrationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderRegistrationError';
  }
}

export interface ProviderRegistry {
  register(input: {
    descriptor: ProviderDescriptor;
    adapter: unknown;
    pluginName: string;
    runtime?: ProviderRuntime;
  }): Promise<RegisteredProvider>;
  unregister(providerId: string): boolean;
  unregisterPlugin(pluginName: string): string[];
  get(providerId: string): RegisteredProvider | undefined;
  list(): RegisteredProvider[];
  /** Providers producing `datatype` (optionally also offering `capability`). */
  forDatatype(datatype: string, capability?: string): RegisteredProvider[];
  clear(): void;
}

export class ProviderVerificationError extends Error {
  constructor(readonly providerId: string, readonly capability: string,
    readonly reason: 'not-installed' | NonNullable<ReturnType<typeof providerCapabilityVerificationIssue>>,
    detail?: string) {
    super(`provider_verification_refused:${providerId}:${capability}:${reason}${detail ? `: ${detail}` : ''}`);
    this.name = 'ProviderVerificationError';
  }
}

/** An explicit owner wall applies to every host request, including OAuth and identity.
 * Providers without contract attestations retain their existing connection behavior. */
export function assertProviderOwnerUnblocked(
  descriptor: Pick<ProviderDescriptor, 'verification'> & Partial<Pick<ProviderDescriptor, 'id'>>,
  operation: string,
): void {
  const blockedOn = descriptor.verification?.blockedOn;
  if (blockedOn) throw new ProviderVerificationError(descriptor.id ?? operation, operation, 'owner-blocked', blockedOn);
}

/** Resolve evidence from the installed descriptor on EVERY call. Unload/reinstall cannot
 * leave a built-in row or cached attestation authorizing a capability the package lacks. */
export function verifiedProviderForCapability(registry: ProviderRegistry, providerId: string, capability?: string): RegisteredProvider {
  const entry = registry.get(providerId);
  if (!entry) throw new ProviderVerificationError(providerId, capability ?? 'syncPage', 'not-installed');
  const reason = providerCapabilityVerificationIssue(entry.descriptor, capability);
  if (reason) throw new ProviderVerificationError(providerId, capability ?? 'syncPage', reason, entry.descriptor.verification?.blockedOn);
  return entry;
}

export function createProviderRegistry(): ProviderRegistry {
  const providers = new Map<string, RegisteredProvider>();
  return {
    async register({ descriptor, adapter, pluginName, runtime = 'js' }) {
      const issues = validateProviderDescriptor(descriptor);
      const versionIssue = issues.find((issue) => issue.startsWith('provider.contractVersion'));
      if (versionIssue) throw new ProviderRegistrationError('unsupported-contract-version', versionIssue);
      if (issues.length > 0) {
        throw new ProviderRegistrationError('invalid-descriptor', `provider descriptor invalid: ${issues.join('; ')}`);
      }
      if (!isProviderAdapter(adapter)) {
        throw new ProviderRegistrationError(
          'invalid-adapter',
          `provider "${descriptor.id}" adapter must implement describe(), syncPage() and invoke()`,
        );
      }
      const existing = providers.get(descriptor.id);
      if (existing) {
        throw new ProviderRegistrationError(
          'duplicate-provider',
          `provider "${descriptor.id}" is already registered by plugin "${existing.pluginName}"`,
        );
      }
      const described = await adapter.describe();
      if (described.id !== descriptor.id || described.contractVersion !== descriptor.contractVersion) {
        throw new ProviderRegistrationError(
          'descriptor-mismatch',
          `provider "${descriptor.id}" adapter describes "${described.id}" v${described.contractVersion}, manifest declares v${descriptor.contractVersion}`,
        );
      }
      const entry: RegisteredProvider = { descriptor, adapter, pluginName, runtime, registeredAt: Date.now() };
      providers.set(descriptor.id, entry);
      return entry;
    },
    unregister(providerId) {
      return providers.delete(providerId);
    },
    unregisterPlugin(pluginName) {
      const removed: string[] = [];
      for (const [id, entry] of providers) {
        if (entry.pluginName === pluginName) {
          providers.delete(id);
          removed.push(id);
        }
      }
      return removed;
    },
    get(providerId) {
      return providers.get(providerId);
    },
    list() {
      return [...providers.values()];
    },
    forDatatype(datatype, capability) {
      return [...providers.values()].filter(
        (entry) =>
          entry.descriptor.datatypes.includes(datatype) &&
          (capability === undefined || entry.descriptor.capabilities.includes(capability)),
      );
    },
    clear() {
      providers.clear();
    },
  };
}

const state = pinModuleState('@papercusp/operator-core.integrations.provider-registry', () => ({
  registry: createProviderRegistry(),
}));

/**
 * The process-wide provider registry, AS IT IS RIGHT NOW. Plugin providers enter it only during
 * plugin discovery, which may not have run in this process yet (WI-10006703), so a reader on a
 * request or sync path uses readyProviderRegistry() instead. A bare call is for the plugin host's
 * own registration/unregistration and for code that has already awaited readiness; the guard in
 * provider-registry-readiness.test.ts lists every such call with its reason.
 */
export function providerRegistry(): ProviderRegistry {
  return state.registry;
}

/** How long a reader waits for this process's first plugin discovery to register providers. */
export const PROVIDER_REGISTRATION_TIMEOUT_MS = 30_000;

/** Plugin discovery did not register providers in time; the registry would be missing some. */
export class ProviderRegistryNotReadyError extends Error {
  readonly code = 'provider_registry_not_ready' as const;
  constructor(readonly waitedMs: number) {
    super(`integration providers are still loading (waited ${waitedMs}ms for plugin discovery); try again shortly`);
    this.name = 'ProviderRegistryNotReadyError';
  }
}

export interface ReadyProviderRegistryOptions {
  timeoutMs?: number;
  /** Test seam: settles when providers are registered. Defaults to the plugin host's signal. */
  whenRegistered?: () => Promise<void>;
}

/**
 * The registry once THIS process's plugin discovery has registered its providers, starting
 * discovery when nothing has (a request-only host defers it to the first request that needs it).
 * Throws ProviderRegistryNotReadyError rather than return a registry that silently lacks the
 * plugin providers, so a caller can say "still loading" instead of "none exist".
 */
export async function readyProviderRegistry(opts: ReadyProviderRegistryOptions = {}): Promise<ProviderRegistry> {
  const timeoutMs = opts.timeoutMs ?? PROVIDER_REGISTRATION_TIMEOUT_MS;
  // Dynamic: the plugin host imports this module, so a static import would be a cycle.
  const whenRegistered =
    opts.whenRegistered ??
    (() => import('../plugin-host-runtime').then(({ whenProvidersRegistered }) => whenProvidersRegistered()));
  const outcome = await withBoundedTimeout(
    () => whenRegistered().then(() => true),
    { fallback: false, timeoutMs, label: 'provider registration' },
  );
  if (!outcome.value) throw new ProviderRegistryNotReadyError(outcome.elapsedMs ?? timeoutMs);
  return state.registry;
}
