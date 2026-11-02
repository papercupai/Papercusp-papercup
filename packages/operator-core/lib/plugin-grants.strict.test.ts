import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  sql: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: h.sql }) }));
vi.mock('node:fs', () => ({ existsSync: h.existsSync, readFileSync: h.readFileSync }));
vi.mock('./papercusp-root', () => ({ papercuspPath: () => '/fixture' }));

import { getGrantsForPluginInHarness } from './plugin-grants';

beforeEach(() => {
  vi.resetAllMocks();
  h.sql.mockResolvedValue([]);
  h.existsSync.mockReturnValue(true);
  h.readFileSync.mockReturnValue(JSON.stringify({
    grants: { 'fixture@1.0.0:test:secrets:read:TOKEN': { grantedAt: 'legacy' } },
  }));
});

describe('authoritative plugin grants', () => {
  it('does not resurrect a revoked PG grant from the legacy file', async () => {
    expect(await getGrantsForPluginInHarness('fixture', '1.0.0', 'test', {
      requireAuthoritative: true,
    })).toEqual([]);
    expect(h.existsSync).not.toHaveBeenCalled();
    expect(h.readFileSync).not.toHaveBeenCalled();
  });

  it('uses current database grants without unioning stale legacy authority', async () => {
    h.sql.mockResolvedValue([{ capability: 'tasks:read' }]);
    expect(await getGrantsForPluginInHarness('fixture', '1.0.0', 'test', {
      requireAuthoritative: true,
    })).toEqual(['tasks:read']);
    expect(h.readFileSync).not.toHaveBeenCalled();
  });

  it('rejects an unavailable authoritative store even when legacy grants exist', async () => {
    const unavailable = new Error('grant store unavailable');
    h.sql.mockRejectedValue(unavailable);
    await expect(getGrantsForPluginInHarness('fixture', '1.0.0', 'test', {
      requireAuthoritative: true,
    })).rejects.toBe(unavailable);
    expect(h.readFileSync).not.toHaveBeenCalled();
  });

  it('preserves the explicit legacy compatibility reader', async () => {
    h.sql.mockRejectedValue(new Error('offline'));
    expect(await getGrantsForPluginInHarness('fixture', '1.0.0', 'test'))
      .toEqual(['secrets:read:TOKEN']);
  });
});
