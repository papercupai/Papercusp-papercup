import { describe, expect, it, vi } from 'vitest';
import { sampleNativePopup, withNativePopupFailure } from './_native-popup-diagnostics';

describe('native popup diagnostics', () => {
  it('brackets the native read without changing or repairing the observed state', async () => {
    const calls: string[] = [];
    let focused = true;
    const result = await sampleNativePopup('after-ready', async () => {
      calls.push('x11'); return { focused };
    }, async () => { calls.push('native'); focused = false; return { visible: false }; });
    expect(calls).toEqual(['x11', 'native', 'x11']);
    expect(result).toMatchObject({ stage: 'after-ready',
      x11Before: { value: { focused: true } }, native: { value: { visible: false } },
      x11After: { value: { focused: false } } });
  });
  it('timestamps completion after the observed asynchronous operation', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const result = await sampleNativePopup('timing', async () => null, async () => {
        vi.setSystemTime(1000); return true;
      });
      expect(result.native.startedAt).toBe('1970-01-01T00:00:00.000Z');
      expect(result.native.endedAt).toBe('1970-01-01T00:00:01.000Z');
    } finally { vi.useRealTimers(); }
  });
  it('retains independent OS evidence when a bridge or OS probe fails', async () => {
    let reads = 0;
    const result = await sampleNativePopup('failure', async () => {
      if (++reads === 1) throw new Error('X11 unavailable');
      return { mapped: false };
    }, async () => { throw new Error('bridge unavailable'); });
    expect(result.x11Before.error).toContain('X11 unavailable');
    expect(result.native.error).toContain('bridge unavailable');
    expect(result.x11After.value).toEqual({ mapped: false });
  });
  it('preserves the original assertion even if evidence attachment fails', async () => {
    const failure = new Error('popup unexpectedly hidden');
    await expect(withNativePopupFailure(async () => { throw failure; },
      async () => { throw new Error('attachment unavailable'); })).rejects.toBe(failure);
  });
  it('does not take a failure snapshot or alter successful results', async () => {
    let captures = 0;
    expect(await withNativePopupFailure(async () => 42, async () => { captures++; })).toBe(42);
    expect(captures).toBe(0);
  });
});
