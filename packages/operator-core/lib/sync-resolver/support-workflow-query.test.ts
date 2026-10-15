import { beforeEach, describe, expect, it, vi } from 'vitest';
const ports = vi.hoisted(() => ({ declaration: vi.fn(), catalog: vi.fn(), sql: {} }));
vi.mock('../workspace-registry', async importOriginal => ({ ...await importOriginal<typeof import('../workspace-registry')>(),
  activeWorkspaceId: () => 'server-workspace' }));
vi.mock('@papercusp/db-org', async importOriginal => ({ ...await importOriginal<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: ports.sql }) }));
vi.mock('../blueprint/operation-service', () => ({ readCurrentSupportWorkflow: ports.declaration }));
vi.mock('../automation/catalog', () => ({ getAutomationCatalog: ports.catalog }));
import { resolveNamedQueryV2 } from './index';
beforeEach(() => { vi.clearAllMocks(); ports.declaration.mockResolvedValue({ approvedRevision: 'current' });
  ports.catalog.mockResolvedValue({ routines: [] }); });
describe('selected operation on the existing automation catalog', () => {
  it('reads one declaration without scanning workspace schedules or accepting caller workspace authority', async () => {
    await expect(resolveNamedQueryV2('automation.catalog', { supportWorkflow: {
      harnessSlug: ' support ', operationId: ' handoff ',
    } })).resolves.toEqual([{ supportWorkflow: { approvedRevision: 'current' } }]);
    expect(ports.declaration).toHaveBeenCalledWith(ports.sql, {
      workspaceId: 'server-workspace', harnessSlug: 'support', operationId: 'handoff',
    });
    expect(ports.catalog).not.toHaveBeenCalled();
    for (const input of [{ workspaceId: 'foreign' }, { supportWorkflow: { harnessSlug: 'support', operationId: 'handoff', workspaceId: 'foreign' } },
      { supportWorkflow: { harnessSlug: '', operationId: 'handoff' } }]) {
      await expect(resolveNamedQueryV2('automation.catalog', input)).rejects.toBeTruthy();
    }
    expect(ports.declaration).toHaveBeenCalledOnce();
  });
  it('preserves both existing no-argument catalog calls', async () => {
    await expect(resolveNamedQueryV2('automation.catalog', {})).resolves.toEqual([{ routines: [] }]);
    await expect(resolveNamedQueryV2('automation.catalog', undefined)).resolves.toEqual([{ routines: [] }]);
    expect(ports.declaration).not.toHaveBeenCalled();
  });
});
