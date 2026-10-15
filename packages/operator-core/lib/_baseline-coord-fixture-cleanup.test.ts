import { describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { disposeBaselineCoordFixture, type BaselineCoordFixture } from './_baseline-coord-fixture';

describe('baseline coordination fixture teardown (WI-10007112)', () => {
  it('preserves the setup failure without calling an uninitialized admin', async () => {
    const setupFailure = new Error('fixture mutex acquisition failed');
    const setup = vi.fn<() => Promise<BaselineCoordFixture>>().mockRejectedValue(setupFailure);
    const cleanup = vi.fn();
    let fixture: BaselineCoordFixture | undefined;

    await expect(setup().then((value) => { fixture = value; })).rejects.toBe(setupFailure);
    await expect(disposeBaselineCoordFixture(fixture, cleanup)).resolves.toBeUndefined();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('cleans the acquired admin before disposing the fixture', async () => {
    const order: string[] = [];
    const admin = vi.fn() as unknown as postgres.Sql;
    const dispose = vi.fn(async () => { order.push('dispose'); });
    const cleanup = vi.fn(async (sql: postgres.Sql) => {
      expect(sql).toBe(admin);
      order.push('cleanup');
    });

    await disposeBaselineCoordFixture({ admin, dispose }, cleanup);
    expect(order).toEqual(['cleanup', 'dispose']);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('disposes the fixture even when table cleanup fails and surfaces that failure', async () => {
    const cleanupFailure = new Error('table cleanup failed');
    const dispose = vi.fn(async () => {});
    const fixture = { admin: vi.fn() as unknown as postgres.Sql, dispose };

    await expect(disposeBaselineCoordFixture(fixture, async () => {
      throw cleanupFailure;
    })).rejects.toBe(cleanupFailure);
    expect(dispose).toHaveBeenCalledOnce();
  });
});
