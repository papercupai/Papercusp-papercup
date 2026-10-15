import { createCache } from '@papercusp/cache';
import { describe, expect, it } from 'vitest';
import { createPushBacklogReader, type PushBacklogProbe } from './push-backlog-reader';

/** A probe whose answers the test releases by hand, recording every call. */
function controllableProbe() {
  const calls: string[] = [];
  const pending: Array<(v: number | null) => void> = [];
  const probe: PushBacklogProbe = (slug) => {
    calls.push(slug);
    return new Promise((resolve) => pending.push(resolve));
  };
  return { probe, calls, release: (v: number | null) => pending.shift()?.(v) };
}

/** Let a released build settle into the cache. */
const settle = () => new Promise((r) => setTimeout(r, 0));

function clockedCache(start = 1_000_000) {
  const t = { now: start };
  return { t, cache: createCache({ clock: () => t.now }) };
}

describe('createPushBacklogReader — WI-10006803 (a health tick must not wait on git)', () => {
  it('a cold miss answers null (unknown) at the deadline instead of waiting for the probe', async () => {
    const { probe, calls } = controllableProbe();
    const read = createPushBacklogReader({ probe, deadlineMs: 20 });
    const started = Date.now();
    await expect(read('papercusp')).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(calls).toEqual(['papercusp']);
  });

  it('the build that outlived the deadline lands in cache and serves the next read without re-probing', async () => {
    const { probe, calls, release } = controllableProbe();
    const read = createPushBacklogReader({ probe, deadlineMs: 20 });
    await read('papercusp');
    release(7);
    await settle();
    await expect(read('papercusp')).resolves.toBe(7);
    expect(calls).toHaveLength(1);
  });

  it('within the soft TTL repeated reads do no git work', async () => {
    let n = 0;
    const read = createPushBacklogReader({ probe: async () => (n++, 3), softTtlMs: 60_000 });
    for (let i = 0; i < 5; i++) await expect(read('papercusp')).resolves.toBe(3);
    expect(n).toBe(1);
  });

  it('past the soft TTL the stale value is served immediately and exactly one refresh runs', async () => {
    const { t, cache } = clockedCache();
    const { probe, calls, release } = controllableProbe();
    const read = createPushBacklogReader({ probe, cache, softTtlMs: 60_000, hardTtlMs: 600_000, deadlineMs: 20 });
    const first = read('papercusp');
    release(4);
    await expect(first).resolves.toBe(4);

    t.now += 61_000;
    // The refresh is still pending, yet both reads return the cached 4 at once.
    await expect(read('papercusp')).resolves.toBe(4);
    await expect(read('papercusp')).resolves.toBe(4);
    expect(calls).toHaveLength(2);

    release(0);
    await settle();
    await expect(read('papercusp')).resolves.toBe(0);
    expect(calls).toHaveLength(2);
  });

  it('past the hard TTL an old value is not served; the read is bounded by the deadline again', async () => {
    const { t, cache } = clockedCache();
    const { probe, calls, release } = controllableProbe();
    const read = createPushBacklogReader({ probe, cache, softTtlMs: 60_000, hardTtlMs: 120_000, deadlineMs: 20 });
    const first = read('papercusp');
    release(9);
    await expect(first).resolves.toBe(9);

    t.now += 121_000;
    await expect(read('papercusp')).resolves.toBeNull();
    expect(calls).toHaveLength(2);
  });

  it('a null probe result is cached, so a failing probe is not retried on every tick', async () => {
    let n = 0;
    const read = createPushBacklogReader({ probe: async () => (n++, null), softTtlMs: 60_000 });
    await expect(read('papercusp')).resolves.toBeNull();
    await expect(read('papercusp')).resolves.toBeNull();
    expect(n).toBe(1);
  });

  it('concurrent cold reads share one probe run (single-flight)', async () => {
    const { probe, calls, release } = controllableProbe();
    const read = createPushBacklogReader({ probe, deadlineMs: 1_000 });
    const a = read('papercusp');
    const b = read('papercusp');
    release(2);
    await expect(Promise.all([a, b])).resolves.toEqual([2, 2]);
    expect(calls).toHaveLength(1);
  });

  it('installs are cached independently', async () => {
    const seen: string[] = [];
    const read = createPushBacklogReader({ probe: async (slug) => (seen.push(slug), slug.length) });
    await expect(read('papercusp')).resolves.toBe(9);
    await expect(read('hiveloop')).resolves.toBe(8);
    await read('papercusp');
    expect(seen).toEqual(['papercusp', 'hiveloop']);
  });
});
