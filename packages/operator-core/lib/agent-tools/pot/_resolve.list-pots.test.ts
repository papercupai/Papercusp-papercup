/**
 * listPots — EI-25272347580822642. It resolved pots one at a time and re-read the
 * per-workspace wake state for every pot, so the system-health tick's list-pots leg grew with
 * pot count times PG latency (measured up to 100s). These tests pin: the wake state is read
 * once per call, pots resolve in parallel but never more than LIST_POTS_CONCURRENCY at once,
 * and the result keeps registry order.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { loadHarnessRegistryMock, getPotTimeWakeMock, readPotWakeStateMock, resolveHivePubkeyMock, flight } =
  vi.hoisted(() => ({
    loadHarnessRegistryMock: vi.fn(),
    getPotTimeWakeMock: vi.fn(),
    readPotWakeStateMock: vi.fn(),
    resolveHivePubkeyMock: vi.fn(),
    flight: { now: 0, max: 0 },
  }));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: {} }),
}));
vi.mock('../../harness-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadHarnessRegistry: loadHarnessRegistryMock,
}));
vi.mock('../../pot/wake', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPotTimeWake: getPotTimeWakeMock,
  readPotWakeState: readPotWakeStateMock,
}));
vi.mock('../../hive-identity', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveHivePubkey: resolveHivePubkeyMock,
}));

import { listPots, LIST_POTS_CONCURRENCY } from './_resolve';

// A pot is a registry project with harness_kind 'hive' (POT_KIND; see isPotProject).
const pot = (slug: string) => ({ slug, path: `/pots/${slug}`, harness_kind: 'hive' });
const SLUGS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9'];
const tick = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => {
  flight.now = 0;
  flight.max = 0;
  loadHarnessRegistryMock.mockReset().mockResolvedValue({
    projects: [...SLUGS.map(pot), { slug: 'not-a-pot', path: '/x', harness_kind: 'coding' }],
  });
  readPotWakeStateMock.mockReset().mockResolvedValue({ subscriptions: [{ on: ['x'] }], lastWakeAt: null });
  getPotTimeWakeMock.mockReset().mockImplementation(async (_sql: unknown, slug: string) => {
    flight.now += 1;
    flight.max = Math.max(flight.max, flight.now);
    await tick();
    flight.now -= 1;
    return { active: slug === 'p2', nextFireAt: null, lastFiredAt: null };
  });
  resolveHivePubkeyMock.mockReset().mockImplementation(async (_ws: string, slug: string) => {
    await tick();
    return `key-${slug}`;
  });
});

describe('listPots', () => {
  it('reads the per-workspace wake state once, not once per pot', async () => {
    const pots = await listPots('ws-1');

    expect(pots).toHaveLength(SLUGS.length);
    expect(readPotWakeStateMock).toHaveBeenCalledTimes(1);
    expect(readPotWakeStateMock).toHaveBeenCalledWith('ws-1');
    expect(getPotTimeWakeMock).toHaveBeenCalledTimes(SLUGS.length);
    for (const p of pots) expect(p.wake.subscriptions).toEqual([{ on: ['x'] }]);
  });

  it('resolves pots in parallel, never more than LIST_POTS_CONCURRENCY at once', async () => {
    await listPots('ws-1');

    expect(LIST_POTS_CONCURRENCY).toBeGreaterThan(1);
    expect(SLUGS.length).toBeGreaterThan(LIST_POTS_CONCURRENCY);
    expect(flight.max).toBe(LIST_POTS_CONCURRENCY);
  });

  it('keeps registry order and pairs each pot with its own pubkey and wake routine', async () => {
    const pots = await listPots('ws-1');

    expect(pots.map((p) => p.slug)).toEqual(SLUGS);
    expect(pots.map((p) => p.pubkey)).toEqual(SLUGS.map((s) => `key-${s}`));
    expect(pots.find((p) => p.slug === 'p2')?.wake.active).toBe(true);
    expect(pots.filter((p) => p.wake.active)).toHaveLength(1);
  });

  it('returns [] without any per-pot or wake-state read when the workspace has no pots', async () => {
    loadHarnessRegistryMock.mockResolvedValue({ projects: [{ slug: 'code-only', path: '/c', harness_kind: 'coding' }] });

    expect(await listPots('ws-1')).toEqual([]);
    expect(readPotWakeStateMock).not.toHaveBeenCalled();
    expect(getPotTimeWakeMock).not.toHaveBeenCalled();
  });

  it('still rejects when a pot read fails, as the serial loop did', async () => {
    getPotTimeWakeMock.mockImplementation(async (_sql: unknown, slug: string) => {
      if (slug === 'p5') throw new Error('routine read failed');
      return null;
    });

    await expect(listPots('ws-1')).rejects.toThrow('routine read failed');
  });
});
