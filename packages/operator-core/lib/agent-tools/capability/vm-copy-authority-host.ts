/** Canonical read adapters. Installed identity/resource/process mappings are
 * required host inputs; there is deliberately no production default or setter. */
import type { Sql } from 'postgres';
import type { KernelEnforcementRequest, UnifiedToolContext } from '@papercusp/tooldef';
import type { VmCopyHost, VmCopyRequest } from './vm-copy-authority';
import { VmCopyRefusal } from './vm-copy-authority';
import { isAllHarnessSentinel } from '../_harness-scope';

export function canonicalVmCopyHost(input: {
  ctx: UnifiedToolContext;
  request: VmCopyRequest;
  operationSql: Sql;
  resourceSql: Sql;
  identity: Pick<VmCopyHost, 'scope' | 'devicePubkey' | 'sign' | 'standing' | 'capabilityRef' | 'resources' | 'process'>;
  /** Descriptor capabilities from the host tool registry, never pin/manifest strings. */
  toolCapabilities(toolName: string): readonly string[] | null;
}): VmCopyHost {
  const scope = input.identity.scope;
  // The operator-scope '*' sentinel is not a concrete harness, so it can never
  // authenticate a harness-bound VM-copy identity (fail closed, explicitly).
  if (!input.ctx.principal || input.ctx.principal.workspaceId !== scope.workspaceId ||
    input.ctx.workspaceId !== scope.workspaceId ||
    isAllHarnessSentinel(input.ctx.harnessSlug) || input.ctx.harnessSlug !== scope.harnessSlug ||
    input.ctx.uiClientId !== scope.ownerId) throw new VmCopyRefusal('vm-copy-authenticated-host-context-mismatch');
  return {
    ...input.identity,
    async worker() {
      const { readActiveOperationWorkerClaimBinding } = await import('../../blueprint/operation-worker-binding');
      return readActiveOperationWorkerClaimBinding(input.identity.scope.workspaceId,
        input.identity.scope.ownerId, { sql: input.operationSql, throwOnError: true });
    },
    async kernel(toolName) {
      const capabilities = input.toolCapabilities(toolName);
      if (!capabilities?.length) return null;
      const { controlAnchorKernelResolver } = await import('../../projected-tool-deps');
      const request: KernelEnforcementRequest = {
        phase: 'enforce', boundary: 'native', toolName, capabilities,
        args: { check: 'vm-copy-authority', request: input.request }, ctx: input.ctx,
        operation: 'vmctl:prepare-diagnostic-copy',
      };
      return controlAnchorKernelResolver(request);
    },
    async queue(pin) {
      const { readResourceQueue } = await import('@papercusp/locks');
      return readResourceQueue(input.resourceSql, { coordinationDomain: pin.coordinationDomain, resource: pin.resource });
    },
  };
}
