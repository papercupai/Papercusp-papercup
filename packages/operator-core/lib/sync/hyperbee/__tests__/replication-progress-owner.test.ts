import { describe, expect, it } from 'vitest';
import { ReplicationProgressOwner } from '../replication-liveness';

const keyHex = 'ab'.repeat(32);
const sample = (owner: ReplicationProgressOwner, nowMs: number, position = 0, knownLength = 10) =>
  owner.sample({ keyHex, knownLength, position, nowMs });

describe('P-531 bounded replication progress ownership', () => {
  it('repairs at the deadline even when repeated announcements increase the target', () => {
    const owner = new ReplicationProgressOwner();
    expect(sample(owner, 0)).toBeNull();
    expect(sample(owner, 29_999, 0, 100)).toBeNull();
    expect(sample(owner, 30_000, 0, 101)).toMatchObject({
      keyHex, knownLength: 101, position: 0, stalledForMs: 30_000,
    });
  });

  it('allows only one repair while close/reopen is pending and bounds the next retry', () => {
    const owner = new ReplicationProgressOwner();
    sample(owner, 0);
    const repair = sample(owner, 30_000)!;
    expect(repair).not.toBeNull();
    expect(sample(owner, 90_000)).toBeNull();
    expect(owner.complete(repair, 90_000)).toBe(true);
    expect(sample(owner, 119_999)).toBeNull();
    const retry = sample(owner, 120_000)!;
    expect(retry.generation).toBeGreaterThan(repair.generation);
    expect(owner.complete(repair, 120_001)).toBe(false);
    expect(sample(owner, 150_000)).toBeNull();
  });

  it('uses actual cursor advance to renew progress, including sparse snapshot positions', () => {
    const owner = new ReplicationProgressOwner();
    expect(sample(owner, 0, 1_000, 2_000)).toBeNull();
    expect(sample(owner, 29_000, 1_001, 2_000)).toBeNull();
    expect(sample(owner, 58_999, 1_001, 2_000)).toBeNull();
    expect(sample(owner, 59_000, 1_001, 2_000)).toMatchObject({ stalledForMs: 30_000 });
  });

  it('keeps caught-up peers idle and starts a fresh deadline when new work arrives', () => {
    const owner = new ReplicationProgressOwner();
    sample(owner, 0, 10, 10);
    expect(sample(owner, 90_000, 10, 10)).toBeNull();
    expect(sample(owner, 90_001, 10, 11)).toBeNull();
    expect(sample(owner, 120_000, 10, 11)).toMatchObject({ stalledForMs: 30_000 });
  });

  it('fences a late repair completion after revocation and re-admission of the same key', () => {
    const owner = new ReplicationProgressOwner();
    sample(owner, 0);
    const old = sample(owner, 30_000)!;
    owner.forget(keyHex);
    sample(owner, 40_000);
    const replacement = sample(owner, 70_000)!;
    expect(owner.complete(old, 80_000)).toBe(false);
    expect(sample(owner, 100_000)).toBeNull();
    expect(owner.complete(replacement, 100_000)).toBe(true);
  });

  it('tracks different remote cores independently and clears them on shutdown', () => {
    const owner = new ReplicationProgressOwner();
    sample(owner, 0);
    owner.sample({ keyHex: 'cd'.repeat(32), knownLength: 10, position: 0, nowMs: 10_000 });
    expect(sample(owner, 30_000)).not.toBeNull();
    expect(owner.sample({ keyHex: 'cd'.repeat(32), knownLength: 10, position: 0, nowMs: 30_000 })).toBeNull();
    owner.clear();
    expect(sample(owner, 100_000)).toBeNull();
  });

  it('rejects unmeasured lengths and invalid deadlines instead of manufacturing a repair', () => {
    expect(() => new ReplicationProgressOwner(0)).toThrow(RangeError);
    const owner = new ReplicationProgressOwner();
    expect(() => sample(owner, 0, NaN)).toThrow(RangeError);
    expect(() => sample(owner, 0, 0, Infinity)).toThrow(RangeError);
    expect(() => sample(owner, NaN)).toThrow(RangeError);
  });
});
