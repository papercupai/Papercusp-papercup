import { describe, expect, it, vi } from 'vitest';
import { createDesktopThumbnailer, type GrabFrame } from './desktop-thumbnail';

const jpeg = (n: number) => Buffer.from([0xff, 0xd8, n]);

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('desktop thumbnailer (P-005 / D-008)', () => {
  it('serves a frame younger than the cache window without re-capturing', async () => {
    const c = clock();
    let n = 0;
    const grab = vi.fn<GrabFrame>(async () => jpeg(++n));
    const t = createDesktopThumbnailer({ grab, now: c.now, cacheMs: 4_000 });
    expect(await t.thumbnail(91)).toEqual(jpeg(1));
    c.advance(3_999);
    expect(await t.thumbnail(91)).toEqual(jpeg(1));
    expect(grab).toHaveBeenCalledTimes(1);
    c.advance(1);
    expect(await t.thumbnail(91)).toEqual(jpeg(2));
    expect(grab).toHaveBeenCalledTimes(2);
  });

  it('SPEC-P-005: a grid polling every 5s sees each desktop refreshed no more than 10s apart', async () => {
    const c = clock();
    const capturedAt = new Map<number, number[]>();
    const grab: GrabFrame = async (display) => {
      capturedAt.set(display, [...(capturedAt.get(display) ?? []), c.now()]);
      return jpeg(display);
    };
    const t = createDesktopThumbnailer({ grab, now: c.now });
    const displays = [91, 92, 93, 94, 95];
    for (let tick = 0; tick < 24; tick++) {
      await Promise.all(displays.map((d) => t.thumbnail(d)));
      c.advance(5_000);
    }
    for (const d of displays) {
      const at = capturedAt.get(d) ?? [];
      expect(at.length).toBeGreaterThan(10);
      const gaps = at.slice(1).map((v, i) => v - at[i]!);
      expect(Math.max(...gaps)).toBeLessThanOrEqual(10_000);
    }
  });

  it('captures nothing when no grid reads (zero idle cost)', async () => {
    const grab = vi.fn<GrabFrame>(async () => jpeg(1));
    createDesktopThumbnailer({ grab });
    await new Promise((r) => setTimeout(r, 20));
    expect(grab).not.toHaveBeenCalled();
  });

  it('coalesces concurrent reads of one display onto a single capture', async () => {
    let finish!: (b: Buffer) => void;
    const frame = new Promise<Buffer>((r) => { finish = r; });
    const grab = vi.fn<GrabFrame>(() => frame);
    const t = createDesktopThumbnailer({ grab });
    const reads = [t.thumbnail(91), t.thumbnail(91), t.thumbnail(91)];
    await vi.waitFor(() => expect(grab).toHaveBeenCalled());
    finish(jpeg(7));
    expect(await Promise.all(reads)).toEqual([jpeg(7), jpeg(7), jpeg(7)]);
    expect(grab).toHaveBeenCalledTimes(1);
    expect(t.stats().coalesced).toBe(2);
  });

  it('runs at most maxConcurrent captures at once across displays', async () => {
    let active = 0;
    let peak = 0;
    const grab: GrabFrame = async (display) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return jpeg(display);
    };
    const t = createDesktopThumbnailer({ grab, maxConcurrent: 2 });
    const out = await Promise.all([91, 92, 93, 94, 95, 96].map((d) => t.thumbnail(d)));
    expect(out.map((b) => b?.[2])).toEqual([91, 92, 93, 94, 95, 96]);
    expect(peak).toBe(2);
  });

  it('hands a released slot to the queued waiter, so a caller arriving at release time cannot exceed the cap', async () => {
    let active = 0;
    let peak = 0;
    const late: Array<Promise<Buffer | null>> = [];
    // Fire a new read at every microtask depth around the release, so whichever hop
    // separates "slot released" from "waiter resumed", one of them lands inside it.
    const atDepth = (k: number, fn: () => void): void => {
      if (k === 0) fn();
      else queueMicrotask(() => atDepth(k - 1, fn));
    };
    let t!: ReturnType<typeof createDesktopThumbnailer>;
    const grab: GrabFrame = async (display) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      if (display === 91) {
        for (let k = 0; k < 8; k++) atDepth(k, () => late.push(t.thumbnail(200 + k)));
      }
      return jpeg(display % 256);
    };
    t = createDesktopThumbnailer({ grab, maxConcurrent: 1 });
    await Promise.all([t.thumbnail(91), t.thumbnail(92)]);
    await new Promise((r) => setTimeout(r, 5));
    await Promise.all(late);
    expect(late).toHaveLength(8);
    expect(peak).toBe(1);
  });

  it('returns null for a display that cannot be grabbed, and does not re-grab it inside the window', async () => {
    const c = clock();
    const grab = vi.fn<GrabFrame>(async () => { throw new Error('no such display'); });
    const t = createDesktopThumbnailer({ grab, now: c.now });
    expect(await t.thumbnail(99)).toBeNull();
    expect(await t.thumbnail(99)).toBeNull();
    expect(grab).toHaveBeenCalledTimes(1);
  });
});
