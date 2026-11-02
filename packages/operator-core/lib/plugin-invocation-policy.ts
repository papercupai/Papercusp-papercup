/** Host binding of the existing PDP, installation grants and checked services.
 * Neither plugin authorize output nor any invocation argument supplies this port.
 * This adapter adds no policy store: the owning host must install its existing
 * resource policy and a synchronous check of its current approval/grant revision.
 */
import { createHash } from 'node:crypto';
import type { DispatchProjectedDeps, PolicyDecisionPoint, AuthDecision, AuthzQuery, Principal } from '@papercusp/agent-mcp';
import { createInvocationCapabilityContext, runWithInvocationCapabilities } from '@papercusp/plugin-loader';
import type { Capability } from '@papercusp/plugin-sdk';
import { canonicalJson } from './authority/authority-rpc-envelope';
import type { getGrantsForPluginInHarness } from './plugin-grants';

type Request = Parameters<NonNullable<DispatchProjectedDeps['aroundInvoke']>>[0];
type Installation = NonNullable<Request['tool']['pluginInstallation']>;

export interface HostPluginInvocationPolicy extends PolicyDecisionPoint {
  /** Fail closed unless this EXACT decision, installation, grant revision and
   * authenticated caller are still current. Must perform no asynchronous IO;
   * a host without a locally current revision cannot issue an active lease.
   */
  isCurrent(query: AuthzQuery, decision: AuthDecision): boolean;
}

let hostPolicy: HostPluginInvocationPolicy | null = null;

/** Trusted boot/control-plane capability; never exposed as a plugin/tool API. */
export function setHostPluginInvocationPolicy(policy: HostPluginInvocationPolicy | null): void {
  hostPolicy = policy;
}

async function loadedManifest(pluginName: string, installation: Installation): Promise<readonly Capability[]> {
  const { getPluginHost } = await import('./plugin-host-runtime');
  const matches = (await getPluginHost()).loaded.filter(lp => lp.plugin.name === pluginName
    && lp.plugin.version === installation.version && lp.path === installation.path && lp.source === installation.source);
  if (matches.length !== 1) throw new Error('exact loaded installation required');
  return [...matches[0].plugin.capabilities];
}

const refuse = (detail: string) => ({ isError: true,
  content: [{ type: 'text' as const, text: JSON.stringify({ error: 'plugin_invocation_authority_required', detail }) }],
});

export function createPluginInvocationChokepoint(deps: {
  resolvePolicy?: () => HostPluginInvocationPolicy | null;
  readManifest?: typeof loadedManifest;
  readGrants?: typeof getGrantsForPluginInHarness;
} = {}): NonNullable<DispatchProjectedDeps['aroundInvoke']> {
  return async request => {
    if (!request.tool.pluginInstallation) return request.invoke();
    const resolvePolicy = deps.resolvePolicy ?? (() => hostPolicy);
    const policy = resolvePolicy();
    if (!policy) return refuse('The host has not bound a current resource policy to this installation');
    const principal = request.ctx.principal;
    const harnessSlug = request.ctx.harnessSlug;
    if (!principal || !['trusted', 'verified'].includes(principal.trust ?? '')
      || !principal.kind || !principal.authMethod || !principal.slug || !principal.workspaceId || principal.workspaceId === '*'
      || request.ctx.workspaceId !== principal.workspaceId || !harnessSlug || !request.callId
      || request.ctx.signal.aborted || !principal.allowedTools?.has(request.toolName)) {
      return refuse('An authenticated workspace, harness and exact tool allowlist are required');
    }

    let context: ReturnType<typeof createInvocationCapabilityContext>;
    try {
      // Snapshot before awaiting host IO. The PDP sees the exact registered
      // operation and installation; caller-controlled fields remain query data.
      const installation = Object.freeze({ ...request.tool.pluginInstallation });
      const pluginName = request.tool.pluginName;
      const boundPrincipal = { ...principal, kind: principal.kind, authMethod: principal.authMethod,
        trust: principal.trust!, capabilities: new Set(principal.capabilities),
        allowedTools: new Set(principal.allowedTools) } satisfies Principal;
      const declaration = { name: request.toolName, capabilities: [...request.tool.capabilities] };
      const input = structuredClone(request.input);
      const dispatchIdentity = () => canonicalJson({ toolName: request.toolName, pluginName: request.tool.pluginName,
        installation: request.tool.pluginInstallation, capabilities: request.tool.capabilities, input: request.input,
        harnessSlug: request.ctx.harnessSlug, workspaceId: request.ctx.workspaceId,
        principal: request.ctx.principal && { ...request.ctx.principal,
          capabilities: [...request.ctx.principal.capabilities].sort(),
          allowedTools: request.ctx.principal.allowedTools && [...request.ctx.principal.allowedTools].sort(),
          roles: request.ctx.principal.roles && [...request.ctx.principal.roles].sort() } });
      const originalIdentity = dispatchIdentity();
      const manifest = [...await (deps.readManifest ?? loadedManifest)(pluginName, installation)];
      const readGrants = deps.readGrants ?? (await import('./plugin-grants')).getGrantsForPluginInHarness;
      const granted = await readGrants(pluginName,
        installation.version, harnessSlug, { requireAuthoritative: true });
      const binding = createHash('sha256').update(canonicalJson({ callId: request.callId,
        toolName: request.toolName, pluginName, installation, harnessSlug, input,
        principal: { slug: boundPrincipal.slug, workspaceId: boundPrincipal.workspaceId,
          capabilities: [...boundPrincipal.capabilities].sort(), allowedTools: [...boundPrincipal.allowedTools].sort() },
        manifest, declaration, granted,
      })).digest('hex');
      const query: AuthzQuery = { principal: boundPrincipal, action: request.toolName,
        resource: { type: 'plugin-installation', id: `${pluginName}@${installation.version}`,
          attributes: { ...installation, harnessSlug } },
        context: { invocationBinding: binding, callId: request.callId, input } };
      const decision = structuredClone(await policy.decide(structuredClone(query)));
      // This obligation is issued by the independently installed HOST PDP.
      // request.authorization and ctx.authObligations deliberately grant nothing.
      const approval = decision?.obligations?.pluginInvocation as {
        binding?: unknown; capabilities?: unknown; expiresAt?: unknown;
      } | undefined;
      if (decision?.allow !== true || approval?.binding !== binding
        || !Array.isArray(approval.capabilities)
        || !approval.capabilities.every(cap => typeof cap === 'string' && cap.length > 0 && !cap.includes('*'))
        || typeof approval.expiresAt !== 'number' || !Number.isFinite(approval.expiresAt)
        || approval.expiresAt <= Date.now()) {
        return refuse('A current host approval bound to this exact invocation is required');
      }
      const isActive = () => !request.ctx.signal.aborted && resolvePolicy() === policy && dispatchIdentity() === originalIdentity
        && policy.isCurrent(structuredClone(query), structuredClone(decision)) === true;
      context = createInvocationCapabilityContext({ pluginName, capabilities: manifest,
        granted: granted as Capability[], principal: boundPrincipal, invocationId: request.callId,
        declaration: declaration as Parameters<typeof createInvocationCapabilityContext>[0]['declaration'],
        approvals: approval.capabilities as Capability[], expiresAt: approval.expiresAt, isActive });
      if (!isActive()) return refuse('The host approval or installation grants are no longer current');
    } catch {
      return refuse('The authoritative installation, grants or resource policy could not be verified');
    }
    // The existing async scope attenuates prebuilt services and nested dispatch,
    // including across the host's metering/capture hooks and awaits.
    return runWithInvocationCapabilities(context, request.invoke);
  };
}

/** Production binding uses the existing owner-signed policy and grant rows.
 * Test/custom hosts may still explicitly install their own trusted PDP. */
export const pluginInvocationChokepoint: NonNullable<DispatchProjectedDeps['aroundInvoke']> = async request => {
  if (!request.tool.pluginInstallation) return request.invoke();
  if (hostPolicy) return createPluginInvocationChokepoint()(request);
  try {
    const { withPinnedPluginInvocationPolicy } = await import('./plugin-invocation-policy-store');
    return await withPinnedPluginInvocationPolicy(request, (policy, grants) =>
      createPluginInvocationChokepoint({ resolvePolicy: () => policy, readGrants: async () => grants })(request));
  } catch {
    return refuse('The current signed host policy and installation grant revision could not be pinned');
  }
};
