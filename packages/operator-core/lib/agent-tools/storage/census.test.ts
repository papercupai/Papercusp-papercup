import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ sql: {}, read: vi.fn(), census: vi.fn() }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({ ...await importOriginal<typeof import('@papercusp/db-org')>(), getOrgPg: () => ({ sql: h.sql }) }));
vi.mock('../../workspace-registry', async (importOriginal) => ({ ...await importOriginal<typeof import('../../workspace-registry')>(), activeWorkspaceId: () => 'workspace-a' }));
vi.mock('../../storage/disk-reclaim', () => ({ readReclaimReceipt: h.read, reclaimReceiptHref: (id: string) => `/settings/storage?reclaim=${id}` }));
vi.mock('../../storage/disk-consumer-census', () => ({ readDiskConsumerCensus: h.census, resolveCensusDevices: async () => [{ device: '/' }, { device: '/mnt/data' }] }));
import tool from './census';

beforeEach(() => { vi.clearAllMocks(); h.read.mockResolvedValue(null); h.census.mockResolvedValue({ host: 'host-a', devices: [] }); });
describe('storage:census receipt access', () => {
  it('reads an exact receipt in the active workspace without requiring the census tables', async () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    h.read.mockResolvedValue({ id, complete: false });
    const result = await tool.handler({ receiptId: id }, {} as never);
    expect(h.read).toHaveBeenCalledWith(h.sql, 'workspace-a', id);
    expect(h.census).not.toHaveBeenCalled();
    expect(result).toEqual({ data: { ok: true, receipt: { id, complete: false }, receiptHref: `/settings/storage?reclaim=${id}` } });
  });
  it('returns explicit absence instead of substituting the latest receipt for a missing id', async () => {
    const result = await tool.handler({ receiptId: '550e8400-e29b-41d4-a716-446655440000' }, {} as never);
    expect(result).toEqual({ data: { ok: true, receipt: null, receiptHref: null } });
  });
  it('retains the census read and adds the latest real receipt when no id is supplied', async () => {
    const result = await tool.handler(undefined, {} as never);
    expect(h.census).toHaveBeenCalledWith(h.sql, expect.objectContaining({ expectedDevices: ['/', '/mnt/data'] }));
    expect(h.read).toHaveBeenCalledWith(h.sql, 'workspace-a', undefined);
    expect(result).toEqual({ data: { ok: true, host: 'host-a', devices: [], receipt: null, receiptHref: null } });
  });
  it('rejects invalid receipt ids at the tool schema boundary', () => {
    expect(tool.args.safeParse({ receiptId: 'bad' }).success).toBe(false);
  });
});
