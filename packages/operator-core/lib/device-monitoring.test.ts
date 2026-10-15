import { describe, it, expect, vi } from 'vitest';
import {
  releaseGateTile,
  releaseGateApplicability,
  poolTile,
  fleetsAndPotsTile,
  connectionTile,
  systemAlerts,
} from './device-monitoring';
import type { OrientPipeline } from './agent-tools/coordination/pipeline-health';
import type { listPresence } from './agent-tools/coordination/presence';
import type { fetchPresenceFleet } from './agent-tools/coordination/presence-fleet';

// ── releaseGateTile (P-009) ──────────────────────────────────────────────────
describe('releaseGateApplicability', () => {
  it('proves absence with a successful strict read of the selected checkpoint routine', async () => {
    const read = vi.fn(async () => null);
    expect(await releaseGateApplicability('customer', { read })).toBe('not-applicable');
    expect(read).toHaveBeenCalledExactlyOnceWith('customer', 'green-checkpoint');
  });

  it.each([true, false])('requires a measurement even when a configured routine is active=%s', async (active) => {
    const read = async () => ({ name: 'green-checkpoint', active, cron: null,
      lastFiredAtMs: null, nextFireAtMs: null, groupSlug: null, pause: null });
    expect(await releaseGateApplicability(undefined, { read })).toBe('configured');
  });

  it('preserves unknown when the strict configuration read fails', async () => {
    const read = async () => { throw new Error('routine store unavailable'); };
    expect(await releaseGateApplicability(undefined, { read })).toBe('unknown');
  });
});

describe('releaseGateTile', () => {
  const pipe = (over: Partial<OrientPipeline>): OrientPipeline => ({
    gate: 'green',
    deploy: 'current',
    checkedAtMs: 1000,
    ...over,
  });

  it('maps a green gate to a non-red tile', async () => {
    const tile = await releaseGateTile(undefined, { fetch: async () => pipe({ gate: 'green' }) });
    expect(tile).toMatchObject({ gate: 'green', deploy: 'current', red: false });
  });

  it('flags a real red (with consecutiveReds + failing-file COUNT, never names)', async () => {
    const tile = await releaseGateTile(undefined, {
      fetch: async () =>
        pipe({ gate: 'red', consecutiveReds: 3, failingFiles: ['a.test.ts', 'b.test.ts'] }),
    });
    expect(tile).toMatchObject({ gate: 'red', red: true, consecutiveReds: 3, failingFileCount: 2 });
    // The phone gets a count, not engineering file names.
    expect(tile as unknown as Record<string, unknown>).not.toHaveProperty('failingFiles');
  });

  it('does NOT treat a stale-verdict gate as red (load-bearing silence)', async () => {
    const tile = await releaseGateTile(undefined, {
      fetch: async () => pipe({ gate: 'stale-verdict' }),
    });
    expect(tile?.red).toBe(false);
  });

  it('treats stalled/wedged/conflict as blocking red', async () => {
    for (const gate of ['stalled', 'wedged', 'conflict'] as const) {
      const tile = await releaseGateTile(undefined, { fetch: async () => pipe({ gate }) });
      expect(tile?.red).toBe(true);
    }
  });

  it('is fail-soft: a throwing reader yields null, never a throw', async () => {
    const tile = await releaseGateTile(undefined, {
      fetch: async () => {
        throw new Error('git had a bad day');
      },
    });
    expect(tile).toBeNull();
  });
});

// ── poolTile (P-007) ─────────────────────────────────────────────────────────
describe('poolTile', () => {
  const acct = (id: string, over: Partial<{ available: boolean; usageWalled: boolean }> = {}) =>
    ({
      id,
      provider: 'anthropic',
      credentialRef: 'ref',
      boundTo: [],
      available: true,
      usageWalled: false,
      sustainedlyLimited: false,
      rate: {},
      liveBuckets: [],
      ...over,
    }) as unknown as Awaited<ReturnType<typeof import('./deployment/account-pool-store').accountStatus>>[number];

  it('counts healthy vs walled and carries the authoritative exhausted flag', async () => {
    const tile = await poolTile(undefined, {
      status: async () => [
        acct('a'),
        acct('b', { available: false, usageWalled: true }),
        acct('c'),
      ],
      exhausted: async () => false,
    });
    expect(tile).toMatchObject({ exhausted: false, healthyCount: 2, walledCount: 1, totalCount: 3 });
  });

  it('reports exhausted when routing has no capacity', async () => {
    const tile = await poolTile(undefined, {
      status: async () => [acct('a', { available: false, usageWalled: true })],
      exhausted: async () => true,
    });
    expect(tile?.exhausted).toBe(true);
  });

  it('is fail-soft', async () => {
    const tile = await poolTile(undefined, {
      status: async () => {
        throw new Error('pg down');
      },
      exhausted: async () => false,
    });
    expect(tile).toBeNull();
  });
});

// ── fleetsAndPotsTile (P-008) ────────────────────────────────────────────────
describe('fleetsAndPotsTile', () => {
  const pres = (o: Partial<{ ownerId: string; ownerLabel: string; stale: boolean; revoked: boolean; potSlug: string | null }>) =>
    ({
      ownerId: 'x',
      ownerLabel: 'x',
      stale: false,
      revoked: false,
      potSlug: null,
      ...o,
    }) as unknown as Awaited<ReturnType<typeof listPresence>>[number];

  it('aggregates live/total by fleet and by pot, naming the leader', async () => {
    const list = (async () => [
      pres({ ownerId: 'leader1', ownerLabel: 'Leader One', potSlug: 'papercusp' }),
      pres({ ownerId: 'm1', potSlug: 'papercusp' }),
      pres({ ownerId: 'm2', stale: true, potSlug: 'papercusp' }), // dead → not live
    ]) as unknown as typeof listPresence;
    const fleets = (async () =>
      new Map([
        ['leader1', { fleetSlug: 'alpha', fleetRole: 'leader' }],
        ['m1', { fleetSlug: 'alpha', fleetRole: 'member' }],
        ['m2', { fleetSlug: 'alpha', fleetRole: 'member' }],
      ])) as unknown as typeof fetchPresenceFleet;

    const tile = await fleetsAndPotsTile('ws', { list, fleets });
    expect(tile).toMatchObject({ agents: 3, live: 2 });
    expect(tile?.fleets).toEqual([
      { fleetSlug: 'alpha', members: 3, live: 2, leader: 'Leader One' },
    ]);
    expect(tile?.pots).toEqual([{ potSlug: 'papercusp', agents: 3, live: 2 }]);
  });

  it('handles an empty roster', async () => {
    const tile = await fleetsAndPotsTile('ws', {
      list: (async () => []) as unknown as typeof listPresence,
      fleets: (async () => new Map()) as unknown as typeof fetchPresenceFleet,
    });
    expect(tile).toMatchObject({ agents: 0, live: 0, fleets: [], pots: [] });
  });

  it('is fail-soft', async () => {
    const tile = await fleetsAndPotsTile('ws', {
      list: (async () => {
        throw new Error('pg down');
      }) as unknown as typeof listPresence,
    });
    expect(tile).toBeNull();
  });
});

// ── connectionTile (P-010) ───────────────────────────────────────────────────
describe('connectionTile', () => {
  it('reports a healthy paired+push+durable device', async () => {
    const tile = await connectionTile('dev1', 'ws', {
      snapshot: async () => ({
        exists: true,
        revoked: false,
        lastSeen: new Date(5000),
        pairedAt: new Date(1000),
        pushPlatforms: ['fcm'],
      }),
      secretStatus: () => ({ durable: true, source: 'env' }),
    });
    expect(tile).toMatchObject({
      paired: true,
      serverReachable: true,
      pushRegistered: true,
      pushPlatforms: ['fcm'],
      lastSeenMs: 5000,
      pairedAtMs: 1000,
      secretDurable: true,
    });
  });

  it('reports a revoked device as not paired', async () => {
    const tile = await connectionTile('dev1', 'ws', {
      snapshot: async () => ({ exists: true, revoked: true, lastSeen: null, pairedAt: new Date(1), pushPlatforms: [] }),
      secretStatus: () => ({ durable: true, source: 'env' }),
    });
    expect(tile).toMatchObject({ paired: false, pushRegistered: false });
  });

  it('surfaces an ephemeral secret so the phone can warn about restart invalidation', async () => {
    const tile = await connectionTile('dev1', 'ws', {
      snapshot: async () => ({ exists: true, revoked: false, lastSeen: null, pairedAt: new Date(1), pushPlatforms: ['apns'] }),
      secretStatus: () => ({ durable: false, source: 'ephemeral', reason: 'x' }),
    });
    expect(tile?.secretDurable).toBe(false);
  });
});

// ── systemAlerts (P-007, PURE) ───────────────────────────────────────────────
describe('systemAlerts', () => {
  it('emits nothing when the gate is green and the pool is healthy', () => {
    expect(
      systemAlerts({
        gate: { gate: 'green', deploy: 'current', red: false, checkedAtMs: 0 },
        pool: { exhausted: false, healthyCount: 3, walledCount: 0, totalCount: 3, accounts: [] },
      }),
    ).toEqual([]);
  });

  it('emits a release-red-gate alert when the gate is red', () => {
    const alerts = systemAlerts({
      gate: { gate: 'red', deploy: 'behind', red: true, consecutiveReds: 2, checkedAtMs: 0 },
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'release-red-gate', severity: 'high' });
    expect(alerts[0].body).toContain('2 consecutive reds');
  });

  it('emits a pool-exhaustion alert when the pool is exhausted', () => {
    const alerts = systemAlerts({
      pool: { exhausted: true, healthyCount: 0, walledCount: 4, totalCount: 4, accounts: [] },
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'pool-exhaustion', severity: 'high' });
    expect(alerts[0].body).toContain('4/4');
  });

  it('emits both when both conditions are active', () => {
    const alerts = systemAlerts({
      gate: { gate: 'wedged', deploy: 'behind', red: true, checkedAtMs: 0 },
      pool: { exhausted: true, healthyCount: 0, walledCount: 2, totalCount: 2, accounts: [] },
    });
    expect(alerts.map((a) => a.kind).sort()).toEqual(['pool-exhaustion', 'release-red-gate']);
  });

  it('tolerates null tiles (fail-soft producers)', () => {
    expect(systemAlerts({ gate: null, pool: null })).toEqual([]);
  });
});

// ── route registration ───────────────────────────────────────────────────────
describe('/device/monitoring route', () => {
  it('is registered device-JWT-gated and read-only (GET)', async () => {
    const mod = await import('./endpoint-route/routes/device/monitoring');
    const routes = mod.default;
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ method: 'GET', path: '/device/monitoring' });
    expect(routes[0].auth).toEqual({ kind: ['device'] });
  });
});
