import { beforeEach, describe, expect, it, vi } from 'vitest';
const reads = vi.hoisted(() => ({ worker: vi.fn(), queue: vi.fn(), kernel: vi.fn() }));
vi.mock('../../blueprint/operation-worker-binding', () => ({ readActiveOperationWorkerClaimBinding: reads.worker }));
vi.mock('../../projected-tool-deps', () => ({ controlAnchorKernelResolver: reads.kernel }));
vi.mock('@papercusp/locks', () => ({ readResourceQueue: reads.queue }));
import { canonicalVmCopyHost } from './vm-copy-authority-host';
import { evaluateVmCopyAuthority } from './vm-copy-authority';
import { fixture, NOW } from './__fixtures__/vm-copy-authority';

beforeEach(() => { vi.resetAllMocks(); });
function canonical() {
  const f = fixture();
  const ctx = { principal: { slug: 'authenticated-test-principal', workspaceId: f.scope.workspaceId },
    workspaceId: f.scope.workspaceId, harnessSlug: f.scope.harnessSlug, uiClientId: f.scope.ownerId };
  const operationSql = vi.fn(); const resourceSql = vi.fn();
  reads.worker.mockResolvedValue(f.worker); reads.kernel.mockResolvedValue(f.kernel);
  reads.queue.mockImplementation(async (_sql, pin) => f.queues[f.pins.findIndex(p => p.resource === pin.resource)]);
  const input = { ctx: ctx as never, request: f.request, operationSql: operationSql as never,
    resourceSql: resourceSql as never, identity: f.host,
    toolCapabilities: (name: string) => name === 'capability:inspect' ? ['capability:code-inspect'] : ['capability:bash'] };
  return { f, input, ctx, operationSql, resourceSql };
}
describe('copy authority canonical read wiring', () => {
  it('uses the current worker, applied kernel and canonical resource queue with the exact domain', async () => {
    const { f, input, ctx, operationSql, resourceSql } = canonical();
    await evaluateVmCopyAuthority(f.request, canonicalVmCopyHost(input), NOW);
    expect(reads.worker).toHaveBeenCalledWith(f.scope.workspaceId, f.scope.ownerId,
      { sql: operationSql, throwOnError: true });
    expect(reads.kernel.mock.calls.map(c => c[0].toolName)).toEqual(['capability:inspect', 'capability:bash']);
    expect(reads.kernel.mock.calls[1][0]).toMatchObject({ ctx, phase: 'enforce', boundary: 'native',
      operation: 'vmctl:prepare-diagnostic-copy', capabilities: ['capability:bash'],
      args: { check: 'vm-copy-authority', request: f.request } });
    for (const pin of f.pins) expect(reads.queue).toHaveBeenCalledWith(resourceSql,
      { coordinationDomain: pin.coordinationDomain, resource: pin.resource });
  });
  it('does not replace missing descriptor capability reach with a generic allow', async () => {
    const { f, input } = canonical(); input.toolCapabilities = () => null as never;
    await expect(evaluateVmCopyAuthority(f.request, canonicalVmCopyHost(input), NOW)).rejects.toThrow('applied-provider-denied');
    expect(reads.kernel).not.toHaveBeenCalled();
  });
  it.each(['workspaceId', 'harnessSlug', 'uiClientId'])('refuses mismatched authenticated context %s before reads', field => {
    const { input, ctx } = canonical(); Object.assign(ctx, { [field]: 'foreign' });
    expect(() => canonicalVmCopyHost(input)).toThrow('authenticated-host-context-mismatch');
    expect(reads.worker).not.toHaveBeenCalled(); expect(reads.queue).not.toHaveBeenCalled();
  });
  it.each(['worker', 'queue', 'kernel'] as const)('propagates unavailable %s without signing', async reader => {
    const { f, input } = canonical(); reads[reader].mockRejectedValue(new Error('reader-unavailable'));
    const sign = vi.spyOn(f.host, 'sign');
    await expect(evaluateVmCopyAuthority(f.request, canonicalVmCopyHost(input), NOW)).rejects.toThrow('reader-unavailable');
    expect(sign).not.toHaveBeenCalled();
  });
});
