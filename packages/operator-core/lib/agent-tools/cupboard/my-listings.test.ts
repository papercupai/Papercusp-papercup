import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../../cupboard/my-listings', () => ({ readMyCupboardListings: h.read }));
import tool from './my-listings';
import { lookupByMcpName } from '@papercusp/tooldef';
import '../index';
beforeEach(() => h.read.mockReset());
describe('cupboard:my-listings tool', () => {
  it('is registered in the production barrel with read-only guidance', () => {
    const entry = lookupByMcpName('cupboard:my-listings');
    expect(entry).toBeTruthy();
    expect(tool.guidance?.when).toContain('published');
    expect(tool.guidance?.notWhen).toContain('public catalog');
  });
  it('returns the shared authenticated inventory', async () => {
    const read = { ok: true, listings: [{ id: 'l', review_status: 'pending' }], drafts: [], nextCursor: null };
    h.read.mockResolvedValue(read);
    expect(await tool.handler({ limit: 20 }, {} as never)).toEqual({ data: read });
    expect(h.read).toHaveBeenCalledWith({ limit: 20 });
  });
});
