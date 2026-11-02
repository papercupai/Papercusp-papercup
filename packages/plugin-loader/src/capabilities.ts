/**
 * Capability enforcement for plugin runtime.
 *
 * Each loaded plugin declares its `capabilities[]` in the manifest. The DI
 * container wraps every host service in a Proxy that checks the plugin's
 * declared caps before delegating.
 *
 * Capability format: namespace:action[:resource]
 *   - 'tasks:read'                    — generic
 *   - 'http:fetch:youtube.com'        — resource-scoped (domain)
 *   - 'secrets:read:YOUTUBE_API_KEY'  — resource-scoped (secret name)
 *
 * Runtime errors:
 *   - MissingCapabilityError — declared method exists but plugin lacks the cap
 *   - UnknownMethodError     — service has no method named X
 */

import type { Capability, ServiceDef, ToolDefinition } from '@papercusp/plugin-sdk';
import type { Principal } from '@papercusp/agent-mcp';
import { AsyncLocalStorage } from 'node:async_hooks';

export class MissingCapabilityError extends Error {
  constructor(public pluginName: string, public capability: Capability | string) {
    super(
      `plugin "${pluginName}" missing capability "${capability}". ` +
      `Add it to the plugin's manifest \`capabilities[]\`.`
    );
    this.name = 'MissingCapabilityError';
  }
}

export class UnknownMethodError extends Error {
  constructor(public service: string, public method: string) {
    super(`service "${service}" has no method "${method}"`);
    this.name = 'UnknownMethodError';
  }
}

export interface CapabilityCheckContext {
  pluginName: string;
  capabilities: readonly Capability[];
  /**
   * User-granted capability set for this (plugin, harness) pair. When
   * present, capability checks AND the manifest-declared set with this
   * granted set — a manifest cap that the user hasn't granted is denied.
   * When undefined, falls back to manifest-only (legacy behavior; the
   * operator host always populates this).
   *
   * Wildcards in `granted` follow the same matching rules as `capabilities`
   * (subdomain `*.host`, suffix `head*`). Granting `http:fetch:*.foo.com`
   * authorizes every subdomain the manifest already declared under it.
   *
   * Rust-port-feedback item 3 — biggest single security improvement.
   */
  granted?: readonly Capability[];
  /** Informational identity only. A serialized copy never carries authority. */
  invocation?: Readonly<{
    id: string;
    toolName: string;
    principalSlug: string;
    workspaceId: string;
    parentInvocationId?: string;
  }>;
}

export interface InvocationCapabilityInput {
  pluginName: string;
  capabilities: readonly Capability[];
  granted: readonly Capability[];
  /** Resolved by the host's transport authenticator, never from handler input. */
  principal: Principal;
  invocationId: string;
  /** Trusted registered tool metadata, further restricting the plugin manifest. */
  declaration: Pick<ToolDefinition, 'name' | 'capabilities' | 'expose'>;
  /** Resource/operation approvals resolved by the host for this invocation. */
  approvals: readonly Capability[];
  expiresAt: number;
  /** Revalidate the host's revocation/grant revision before each effect. */
  isActive: () => boolean;
  parent?: CapabilityCheckContext;
}

interface InvocationAuthority {
  identity: NonNullable<CapabilityCheckContext['invocation']>;
  caps: Readonly<Record<'manifest' | 'declaration' | 'installation' | 'caller' | 'approval', readonly string[]>>;
  allowedTools: ReadonlySet<string>;
  expiresAt: number;
  isActive: () => boolean;
  valid: boolean;
  parents: readonly InvocationAuthority[];
}

// Only a host-created context has an entry here. JSON, spreads, and claimed
// principal/bypass fields in handler input cannot manufacture that entry.
const invocationAuthorities = new WeakMap<CapabilityCheckContext, InvocationAuthority>();
// The package is also imported by browser UI hosts, where node builtins are
// externalized. Legacy capability checks can load there, but authenticated
// invocation execution requires native async context and must never fall back.
const invocationScope = typeof AsyncLocalStorage === 'function'
  ? new AsyncLocalStorage<readonly InvocationAuthority[]>()
  : null;

/**
 * Extend the existing capability context with invocation-scoped restrictions.
 * This is a trusted host seam, not an authenticator or a handler API. The host
 * supplies its existing resolved Principal and installation/approval decisions.
 * Every axis is mandatory here; the legacy manifest-only context remains for
 * hosts that have not yet adopted invocation dispatch.
 */
export function createInvocationCapabilityContext(input: InvocationCapabilityInput): CapabilityCheckContext {
  const ambient = invocationScope?.getStore() ?? [];
  const explicitParent = input.parent && invocationAuthorities.get(input.parent);
  const parents = [...new Set([...ambient, ...(explicitParent ? [explicitParent] : [])])];
  const principal = input.principal;
  const identity = Object.freeze({
    id: input.invocationId,
    toolName: input.declaration?.expose?.mcp?.name ?? input.declaration?.name,
    principalSlug: principal?.slug,
    workspaceId: principal?.workspaceId,
    ...(parents.length ? { parentInvocationId: parents[parents.length - 1].identity.id } : {}),
  });
  const snapshot = (caps: readonly string[] | undefined) => Object.freeze([...(caps ?? [])]);
  const capabilities = snapshot(input.capabilities) as readonly Capability[];
  const granted = snapshot(input.granted) as readonly Capability[];
  const ctx: CapabilityCheckContext = Object.freeze({
    pluginName: input.pluginName, capabilities, granted, invocation: identity,
  });
  invocationAuthorities.set(ctx, {
    identity,
    caps: {
      manifest: capabilities,
      declaration: snapshot(input.declaration?.capabilities),
      installation: granted,
      caller: snapshot(principal?.capabilities && [...principal.capabilities]),
      approval: snapshot(input.approvals),
    },
    allowedTools: new Set(principal?.allowedTools ?? []),
    expiresAt: input.expiresAt,
    isActive: input.isActive,
    valid: invocationScope !== null && Boolean(identity.id && identity.toolName && identity.principalSlug && identity.workspaceId)
      && (principal?.trust === 'trusted' || principal?.trust === 'verified')
      && (!input.parent || Boolean(explicitParent))
      && parents.every(p => p.identity.workspaceId === identity.workspaceId
        && p.identity.principalSlug === identity.principalSlug),
    parents,
  });
  return ctx;
}

function capSetAllows(caps: readonly string[], target: string): boolean {
  return caps.some(declared => declared === target || matchWildcardCap(declared, target));
}

function invocationIsActive(authority: InvocationAuthority, toolName: string): boolean {
  try {
    return authority.valid && Number.isFinite(authority.expiresAt)
      && Date.now() < authority.expiresAt && authority.isActive() === true
      && authority.allowedTools.has(authority.identity.toolName)
      && authority.allowedTools.has(toolName);
  } catch {
    // A failed revocation lookup is a denial, before the host effect.
    return false;
  }
}

function invocationAllows(authority: InvocationAuthority, cap: string | undefined, toolName: string, seen = new Set<InvocationAuthority>()): boolean {
  if (seen.has(authority)) return true;
  if (seen.size >= 64) return false;
  seen.add(authority);
  return invocationIsActive(authority, toolName)
    && (cap === undefined || (!cap.includes('*') && Object.values(authority.caps).every(caps => capSetAllows(caps, cap))))
    && authority.parents.every(parent => invocationAllows(parent, cap, toolName, seen));
}

/** Host dispatch and checked services use this to preserve limits across awaits. */
export function runWithInvocationCapabilities<T>(ctx: CapabilityCheckContext, effect: () => T): T {
  const authority = invocationAuthorities.get(ctx);
  const scope = [...new Set([...(invocationScope?.getStore() ?? []), ...(authority ? [authority] : [])])];
  if (!invocationScope || !authority || !scope.every(a => invocationAllows(a, undefined, authority.identity.toolName))) {
    throw new MissingCapabilityError(ctx.pluginName, 'invocation:authenticated');
  }
  return invocationScope.run(scope, effect);
}

function runCapabilityEffect<T>(ctx: CapabilityCheckContext, effect: () => T): T {
  return invocationAuthorities.has(ctx) ? runWithInvocationCapabilities(ctx, effect) : effect();
}

/**
 * Check whether a plugin holds a specific capability.
 *
 * Supports two flavors of resource-scoped wildcard in the *declared* caps:
 *
 *   - Subdomain (used by `http:fetch`): `http:fetch:*.youtube.com` matches
 *     any `http:fetch:<sub>.youtube.com` request. The leading `*.` is
 *     literal — `*foo` (no dot) does not match.
 *
 *   - Suffix (used by `secrets:read`):  `secrets:read:YT_*` matches any
 *     `secrets:read:YT_<rest>` request. Useful for plugins that consume
 *     a family of related secrets without declaring each one.
 *
 * Wildcards are resolved scoped to a `prefix:` namespace; a `*` wildcard
 * cap can never match a request from a different prefix.
 */
export function hasCapability(ctx: CapabilityCheckContext, cap: Capability | string): boolean {
  const target = String(cap);
  if (!capSetAllows(ctx.capabilities, target)) return false;
  if (ctx.granted !== undefined && !capSetAllows(ctx.granted, target)) return false;
  const authority = invocationAuthorities.get(ctx);
  if (ctx.invocation !== undefined && !authority) return false;
  const authorities = [...(invocationScope?.getStore() ?? []), ...(authority ? [authority] : [])];
  const toolName = authority?.identity.toolName ?? authorities[authorities.length - 1]?.identity.toolName;
  return authorities.every(a => invocationAllows(a, target, toolName!));
}

/**
 * Wildcard matching for declared caps. Returns true iff `declared` is a
 * wildcard pattern and `requested` is in its match set. Both inputs share
 * the form `<prefix>:<resource>`; the prefix must match exactly.
 *
 * Patterns recognised in `declared`:
 *   1. `<prefix>:*.<suffix>`     subdomain-style: requested `<prefix>:<host>`
 *                                where `host` ends with `.<suffix>` matches.
 *   2. `<prefix>:<head>*`        prefix-style:    requested `<prefix>:<x>`
 *                                where `x` starts with `<head>` matches.
 *                                (`<head>` must be non-empty to avoid the
 *                                degenerate "match-everything" cap.)
 */
export function matchWildcardCap(declared: string, requested: string): boolean {
  if (!declared.includes('*')) return false;
  const dColon = declared.indexOf(':');
  const rColon = requested.indexOf(':');
  if (dColon < 0 || rColon < 0) return false;
  // Cap may have multiple colon-separated segments (`http:fetch:host`).
  // Use the last colon as the prefix-vs-resource split.
  const dPrefix = declared.slice(0, declared.lastIndexOf(':'));
  const rPrefix = requested.slice(0, requested.lastIndexOf(':'));
  if (dPrefix !== rPrefix) return false;
  const dResource = declared.slice(declared.lastIndexOf(':') + 1);
  const rResource = requested.slice(requested.lastIndexOf(':') + 1);
  // Subdomain wildcard: `*.suffix` matches host ending in `.suffix`.
  if (dResource.startsWith('*.')) {
    const suffix = dResource.slice(1); // ".suffix"
    return rResource.endsWith(suffix) && rResource.length > suffix.length;
  }
  // Prefix wildcard: `head*` (head must be non-empty).
  if (dResource.endsWith('*')) {
    const head = dResource.slice(0, -1);
    if (head.length === 0) return false;
    return rResource.startsWith(head) && rResource.length > head.length;
  }
  return false;
}

/**
 * Throw MissingCapabilityError if the plugin doesn't have the cap.
 */
export function requireCapability(ctx: CapabilityCheckContext, cap: Capability | string): void {
  if (!hasCapability(ctx, cap)) {
    throw new MissingCapabilityError(ctx.pluginName, cap);
  }
}

/**
 * Wrap a "real service" with a Proxy that checks caps before delegating.
 *
 * Usage:
 *   const realTasks = makeRealTasksService(db);
 *   const TasksDef = defineService({
 *     name: 'tasks',
 *     methods: {
 *       list: { capability: 'tasks:read' },
 *       get:  { capability: 'tasks:read' },
 *       create: { capability: 'tasks:write' },
 *     }
 *   });
 *   const scopedTasks = wrapServiceWithCaps(plugin, realTasks, TasksDef);
 *   // Plugin's UI/hooks now use scopedTasks.list() etc., capability-checked.
 */
export function wrapServiceWithCaps<T extends Record<string, (...a: any[]) => any>>(
  ctx: CapabilityCheckContext,
  realService: T,
  serviceDef: ServiceDef
): T {
  // Skip Symbol props and well-known JS introspection keys to keep the proxy
  // playing nice with `typeof`, `for-in`, `Object.keys`, error stringification, etc.
  const PASS_THROUGH_KEYS = new Set([
    'then', 'catch', 'finally',                             // promise interop
    Symbol.toPrimitive as unknown as string,
    Symbol.iterator as unknown as string,
    Symbol.asyncIterator as unknown as string,
    'toString', 'valueOf', 'inspect', 'constructor',
  ]);

  return new Proxy(realService, {
    get(target, prop, receiver) {
      // Symbol or known-pass-through key: defer to real target.
      if (typeof prop === 'symbol' || PASS_THROUGH_KEYS.has(prop as string)) {
        return Reflect.get(target, prop, receiver);
      }

      // Method declared in the service def → return capability-checked wrapper.
      const methodDef = serviceDef.methods[prop as string];
      if (methodDef) {
        const realMethod = target[prop as keyof T] as ((...a: any[]) => any) | undefined;
        if (typeof realMethod !== 'function') {
          // Service def declared the method but the real service doesn't implement it. Programming error.
          throw new Error(`service "${serviceDef.name}" missing implementation for method "${String(prop)}"`);
        }
        return (...args: any[]) => {
          const requiredCap =
            typeof methodDef.capability === 'function'
              ? methodDef.capability(...args)
              : methodDef.capability;
          requireCapability(ctx, requiredCap);
          return runCapabilityEffect(ctx, () => realMethod.apply(target, args));
        };
      }

      // Method NOT declared in service def — block all access (including
      // non-function props, since plugins shouldn't poke at service internals).
      throw new UnknownMethodError(serviceDef.name, String(prop));
    },
  }) as T;
}

/**
 * Wrap fetch with domain allowlist enforcement. Plugin can only hit domains
 * that appear in its `http:fetch:<domain>` capabilities.
 *
 * Matching: exact host, OR subdomain wildcard (`http:fetch:*.youtube.com`
 * matches any `http:fetch:<sub>.youtube.com`). Wildcards are evaluated by
 * `hasCapability`.
 */
export function makeFetchProxy(
  ctx: CapabilityCheckContext,
  realFetch: typeof fetch = fetch
): typeof fetch {
  // fetch must always return a promise — even on validation failure.
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const urlString = typeof input === 'string' ? input : input.toString();
    let host: string;
    try {
      host = new URL(urlString).hostname;
    } catch {
      return Promise.reject(new Error(`plugin "${ctx.pluginName}" attempted invalid URL: ${urlString}`));
    }
    const cap: Capability = `http:fetch:${host}`;
    if (!hasCapability(ctx, cap)) {
      return Promise.reject(new MissingCapabilityError(ctx.pluginName, cap));
    }
    return runCapabilityEffect(ctx, () => realFetch(input as any, init));
  }) as typeof fetch;
}

/**
 * Wrap the secrets service so each `read(name)` call checks for the
 * resource-specific capability `secrets:read:<NAME>`. Plugins may declare
 * exact names or prefix wildcards (`secrets:read:YT_*` matches any name
 * starting with `YT_`). Wildcards are evaluated by `hasCapability`.
 */
export function makeSecretsProxy(
  ctx: CapabilityCheckContext,
  resolve: (name: string) => Promise<string>
) {
  return {
    async read(name: string): Promise<string> {
      const cap: Capability = `secrets:read:${name}`;
      requireCapability(ctx, cap);
      return runCapabilityEffect(ctx, () => resolve(name));
    },
  };
}
