import { describe, expect, it, vi } from 'vitest';

const loaded = vi.hoisted(() => new Set<string>());
vi.mock('./agent-tools/coordination/pipeline-health', () => {
  loaded.add('pipeline');
  return { fetchOrientPipeline: async () => ({ gate: 'green', deploy: 'current', checkedAtMs: 1 }) };
});
vi.mock('./deployment/account-pool-store', () => {
  loaded.add('accounts');
  return { accountStatus: async () => [], accountRoutingExhausted: async () => false };
});
vi.mock('./agent-tools/coordination/presence', () => {
  loaded.add('presence');
  return { listPresence: async () => [] };
});
vi.mock('./agent-tools/coordination/presence-fleet', () => {
  loaded.add('fleets');
  return { fetchPresenceFleet: async () => new Map() };
});
vi.mock('./device-store', () => {
  loaded.add('devices');
  return { deviceConnectionSnapshot: async () => ({ exists: true, revoked: false,
    pushPlatforms: [], lastSeen: null, pairedAt: null }) };
});
vi.mock('./device-jwt', () => {
  loaded.add('jwt');
  return { mobileJwtSecretStatus: () => ({ durable: true }) };
});

import { connectionTile, fleetsAndPotsTile, poolTile, releaseGateTile } from './device-monitoring';

describe('independent monitoring tile startup', () => {
  it('keeps injected release-only callers independent and loads default readers on demand', async () => {
    expect([...loaded]).toEqual([]);
    expect(await releaseGateTile('private-fixture', {
      fetch: async () => ({ gate: 'wedged', deploy: 'current', checkedAtMs: 2 }),
    })).toMatchObject({ gate: 'wedged', red: true });
    expect([...loaded]).toEqual([]);

    expect(await releaseGateTile()).toMatchObject({ gate: 'green', red: false });
    expect([...loaded].sort()).toEqual(['pipeline']);
    expect(await poolTile()).toMatchObject({ exhausted: false, totalCount: 0 });
    expect([...loaded].sort()).toEqual(['accounts', 'pipeline']);
    expect(await fleetsAndPotsTile('private-fixture')).toMatchObject({ agents: 0, fleets: [] });
    expect([...loaded].sort()).toEqual(['accounts', 'fleets', 'pipeline', 'presence']);
    expect(await connectionTile('phone', 'private-fixture')).toMatchObject({ paired: true, secretDurable: true });
    expect([...loaded].sort()).toEqual(['accounts', 'devices', 'fleets', 'jwt', 'pipeline', 'presence']);
  });
});
