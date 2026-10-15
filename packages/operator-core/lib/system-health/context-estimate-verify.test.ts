import { describe, expect, it, vi } from 'vitest';
import { refreshContextEstimateAtBoundary } from './context-estimate-verify';

describe('refreshContextEstimateAtBoundary (WI-4154 compaction fast path)', () => {
  it('re-derives + writes the fresh post-boundary value through to PG', async () => {
    const estimate = vi.fn(async () => 60_298);
    const writePgEstimate = vi.fn(async () => true);
    const out = await refreshContextEstimateAtBoundary('su-a', {
      estimate,
      writePgEstimate,
      resolveSession: async () => ({ nativeSessionId: 'native-a', advSessionId: 11 }),
    });
    expect(out).toBe(60_298);
    expect(estimate).toHaveBeenCalledWith('su-a');
    expect(writePgEstimate).toHaveBeenCalledWith('su-a', 60_298, {
      nativeSessionId: 'native-a',
      advSessionId: 11,
    });
  });

  it('returns null (no write) when the estimator is blind', async () => {
    const writePgEstimate = vi.fn(async () => true);
    const out = await refreshContextEstimateAtBoundary('su-b', {
      estimate: async () => null,
      writePgEstimate,
      resolveSession: async () => ({ nativeSessionId: 'native-b' }),
    });
    expect(out).toBeNull();
    expect(writePgEstimate).not.toHaveBeenCalled();
  });

  it('writes only after the owner mapping reaches the exact successor native session', async () => {
    const estimate = vi.fn(async () => 12_000);
    const writePgEstimate = vi.fn(async () => true);
    const resolveSessionId = vi.fn(async () => 'new-native-id');

    await expect(
      refreshContextEstimateAtBoundary('su-new', {
        expectedSessionId: 'new-native-id',
        resolveSessionId,
        estimate,
        writePgEstimate,
      }),
    ).resolves.toBe(12_000);
    expect(resolveSessionId).toHaveBeenCalledWith('su-new');
    expect(writePgEstimate).toHaveBeenCalledWith('su-new', 12_000, {
      nativeSessionId: 'new-native-id',
      advSessionId: null,
    });
  });

  it('leaves PG unknown when the detached bridge still resolves the predecessor session', async () => {
    const estimate = vi.fn(async () => 190_000);
    const writePgEstimate = vi.fn(async () => {});

    await expect(
      refreshContextEstimateAtBoundary('su-race', {
        expectedSessionId: 'successor-id',
        resolveSessionId: async () => 'predecessor-id',
        estimate,
        writePgEstimate,
      }),
    ).resolves.toBeNull();
    expect(estimate).not.toHaveBeenCalled();
    expect(writePgEstimate).not.toHaveBeenCalled();
  });

  it('never throws: estimator throw → null; PG-write throw → still returns fresh', async () => {
    expect(
      await refreshContextEstimateAtBoundary('su-c', {
        resolveSession: async () => ({ nativeSessionId: 'native-c' }),
        estimate: async () => {
          throw new Error('boom');
        },
      }),
    ).toBeNull();
    expect(
      await refreshContextEstimateAtBoundary('su-d', {
        estimate: async () => 42_000,
        resolveSession: async () => ({ nativeSessionId: 'native-d' }),
        writePgEstimate: async () => {
          throw new Error('pg down');
        },
      }),
    ).toBe(42_000);
  });

  it('returns null when the guarded write reports that the session changed after estimation', async () => {
    const writePgEstimate = vi.fn(async () => false);
    await expect(refreshContextEstimateAtBoundary('su-raced', {
      expectedSessionId: 'successor-id',
      resolveSession: async () => ({ nativeSessionId: 'successor-id', advSessionId: 12 }),
      estimate: async () => 190_000,
      writePgEstimate,
    })).resolves.toBeNull();
    expect(writePgEstimate).toHaveBeenCalledWith('su-raced', 190_000, {
      nativeSessionId: 'successor-id',
      advSessionId: 12,
    });
  });
});
