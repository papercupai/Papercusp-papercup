import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ sql: vi.fn(), readLaunch: vi.fn(), appliedArtifact: vi.fn() }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('../memory/backend', () => ({ getMemoryBackend: vi.fn() }));
vi.mock('../agent-tools/coordination/control-anchor', () => ({ readGateSelectedLaunchSpec: h.readLaunch }));
vi.mock('../capability-envelope/identity-grants-port', () => ({ appliedOrCurrentIdentityArtifact: h.appliedArtifact }));

const { wornMemoryIdentityIds } = await import('./identity-learning');

describe('memory provenance uses the applied identity artifact', () => {
  beforeEach(() => vi.resetAllMocks());

  it('does not attribute an unapplied desired stack to the writer', async () => {
    h.sql.mockResolvedValue([{ applied: null }]);
    expect(await wornMemoryIdentityIds('writer', 'workspace')).toEqual([]);
    expect(h.readLaunch).not.toHaveBeenCalled();
    expect(h.sql.mock.calls[0].slice(1)).toEqual(['writer', 'workspace']);
  });

  it('selects distinct blueprint package inputs from the applied revision', async () => {
    const revision = { specificationRevision: 'applied-spec', stateRevision: 'applied-state' };
    const launch = { specificationRevision: 'desired-spec' };
    h.sql.mockResolvedValue([{ applied: revision }]);
    h.readLaunch.mockResolvedValue(launch);
    h.appliedArtifact.mockReturnValue({ inputs: [
      { kind: 'package', packageKind: 'blueprint', ref: 'worn-identity' },
      { kind: 'package', packageKind: 'blueprint', ref: 'worn-identity' },
      { kind: 'package', packageKind: 'knowledge-pack', ref: 'lesson-pack' },
      { kind: 'first-party', ref: 'kernel' },
    ] });
    expect(await wornMemoryIdentityIds('writer', 'workspace')).toEqual(['worn-identity']);
    // WI-10004801: narrowed to the applied receipt, never the whole record.
    expect(h.readLaunch).toHaveBeenCalledWith(h.sql, 'writer', 'workspace', [revision]);
    expect(h.appliedArtifact).toHaveBeenCalledWith(launch, revision);
  });

  it('refuses a memory write when its applied artifact cannot be recovered', async () => {
    h.sql.mockResolvedValue([{ applied: { specificationRevision: 'missing', stateRevision: 'state' } }]);
    h.readLaunch.mockResolvedValue(null);
    h.appliedArtifact.mockReturnValue(null);
    await expect(wornMemoryIdentityIds('writer', 'workspace')).rejects.toThrow('refusing unstamped memory write');
  });
});
