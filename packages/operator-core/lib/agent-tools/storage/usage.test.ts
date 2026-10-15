import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  computeStorageUsage: vi.fn(),
  sumStorageUsageTotalBytes: vi.fn(),
}));

vi.mock('../../storage/usage', () => ({
  computeStorageUsage: h.computeStorageUsage,
  sumStorageUsageTotalBytes: h.sumStorageUsageTotalBytes,
  STORAGE_READ_BUDGET_MS: 30_000,
}));

import tool from './usage';

describe('storage:usage category filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts a known category and rejects unknown category ids', () => {
    expect(tool.args.safeParse({}).success).toBe(true);
    expect(tool.args.safeParse({ category: 'tool-invocations' }).success).toBe(true);
    expect(tool.args.safeParse({ category: 'not-a-category' }).success).toBe(false);
  });

  it('passes the selected category to the usage reader', async () => {
    const categories = [{ id: 'tool-invocations', totalBytes: 120 }];
    h.computeStorageUsage.mockResolvedValue(categories);
    h.sumStorageUsageTotalBytes.mockReturnValue(120);

    const result = await tool.handler({ category: 'tool-invocations' } as never, {} as never);

    expect(h.computeStorageUsage).toHaveBeenCalledWith({ categoryId: 'tool-invocations' });
    expect(h.sumStorageUsageTotalBytes).toHaveBeenCalledWith(categories);
    expect(result).toEqual({ data: { ok: true, totalBytes: 120, categories } });
  });

  it.each([
    { parentBudgetMs: 10_000, expectedBudgetMs: 9_000 },
    { parentBudgetMs: 60_000, expectedBudgetMs: 30_000 },
  ])(
    'bounds nested reads to the smaller foreground budget ($parentBudgetMs ms parent)',
    async ({ parentBudgetMs, expectedBudgetMs }) => {
      const nowMs = 1_000_000;
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(nowMs);
      h.computeStorageUsage.mockResolvedValue([]);
      h.sumStorageUsageTotalBytes.mockReturnValue(0);

      try {
        await tool.handler(
          { category: 'scratch' } as never,
          { deadlineAtMs: nowMs + parentBudgetMs } as never,
        );

        expect(h.computeStorageUsage).toHaveBeenCalledWith({
          categoryId: 'scratch',
          deadlineMs: nowMs + expectedBudgetMs,
        });
      } finally {
        nowSpy.mockRestore();
      }
    },
  );

  it('keeps the all-category behavior when the filter is omitted', async () => {
    const categories = [{ id: 'tool-invocations', totalBytes: 120 }, { id: 'scratch', totalBytes: 30 }];
    h.computeStorageUsage.mockResolvedValue(categories);
    h.sumStorageUsageTotalBytes.mockReturnValue(150);

    await tool.handler({} as never, {} as never);

    expect(h.computeStorageUsage).toHaveBeenCalledWith({ categoryId: undefined });
  });
});
