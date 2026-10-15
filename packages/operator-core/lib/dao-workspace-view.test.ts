import { describe, expect, it, vi } from 'vitest';
import { buildDaoWorkspaceView, type DaoWorkspaceDeps } from './dao-workspace-view';
import type { HiveDirectoryBrowseRow } from './discovery-hive-rows';

const directory: HiveDirectoryBrowseRow = { potId: 'owner-home', title: 'DAO', description: '', owner: 'owner', visibility: 'public', hivePubkey: 'verified-key', memberTopics: [], memberLinks: [], memberCount: 0, createdAt: 1, lastSeenMs: 1 };
function dependencies(): DaoWorkspaceDeps {
  return {
    viewerGithubId: vi.fn().mockResolvedValue(1),
    projects: vi.fn().mockResolvedValue([{ slug: 'local-renamed', title: 'Local DAO', harness_kind: 'hive', remote_hive: true }, { slug: 'project', title: 'Project', hive_slug: 'local-renamed' }]),
    hive: vi.fn().mockResolvedValue({ pubkeyBase64: 'verified-key' }),
    members: vi.fn().mockResolvedValue([{ githubUserId: 1, githubUsername: 'contributor', displayName: 'Contributor', bindingStatus: 'bound', deviceAttestations: [{ pubkey: 'public-key' }], revokedPubkeys: ['revoked'], workspaceId: 'w', potHomeSlug: 'owner-home' }]),
    policyScope: vi.fn().mockResolvedValue('owner-home'),
    policy: vi.fn().mockResolvedValue(null),
    governance: vi.fn().mockResolvedValue({ potId: 'owner-home', events: [], integrityErrors: [], conflictedRoundIds: new Set() }),
    plans: vi.fn().mockResolvedValue([]),
  };
}

describe('DAO workspace reader boundaries', () => {
  it('revokes contributor work when the authenticated viewer leaves the membership roster', async () => {
    const deps = dependencies();
    Object.assign(deps, { viewerGithubId: async () => 1 });
    expect((await buildDaoWorkspaceView('w', directory, deps)).status).toBe('connected');
    deps.members = vi.fn().mockResolvedValue([]);
    const removed = await buildDaoWorkspaceView('w', directory, deps);
    expect(removed.status).toBe('not-joined');
    expect(removed.projects).toBeUndefined();
    expect(removed.localHomeSlug).toBeNull();
  });
  it('binds a discovered DAO to a renamed joined home by pubkey and uses the correct local adapter', async () => {
    const deps = dependencies();
    const result = await buildDaoWorkspaceView('w', directory, deps);
    expect(result.localHomeSlug).toBe('local-renamed');
    expect(deps.members).toHaveBeenCalledWith('w', 'local-renamed');
    expect(deps.plans).toHaveBeenCalledWith('w', 'project');
    expect(result.members).toEqual({ status: 'ready', value: [{ id: 1, username: 'contributor', displayName: 'Contributor', bindingStatus: 'bound', devices: 1 }] });
    expect(result.projects).toEqual({ status: 'ready', value: [
      { slug: 'local-renamed', title: 'DAO', plans: [] },
      { slug: 'project', title: 'project', plans: [] },
    ] });
  });
  it('does not expose a same-name local DAO with a different identity', async () => {
    const deps = dependencies();
    deps.projects = vi.fn().mockResolvedValue([{ slug: directory.potId, harness_kind: 'hive' }]);
    deps.hive = vi.fn().mockResolvedValue({ pubkeyBase64: 'another-key' });
    expect((await buildDaoWorkspaceView('w', directory, deps)).status).toBe('not-joined');
    expect(deps.members).not.toHaveBeenCalled();
    expect(deps.governance).not.toHaveBeenCalled();
  });
  it('fails closed when the membership access read is unavailable', async () => {
    const deps = dependencies();
    deps.members = vi.fn().mockRejectedValue(new Error('db unavailable'));
    const result = await buildDaoWorkspaceView('w', directory, deps);
    expect(result.members?.status).toBe('error');
    expect(result.status).toBe('not-joined');
    expect(result.governance).toBeUndefined();
    expect(deps.plans).not.toHaveBeenCalled();
  });
  it('requires an authenticated current member before reading contributor work', async () => {
    for (const viewer of [null, 999]) {
      const deps = dependencies();
      deps.viewerGithubId = vi.fn().mockResolvedValue(viewer);
      const result = await buildDaoWorkspaceView('w', directory, deps);
      expect(result.status).toBe('not-joined');
      expect(deps.governance).not.toHaveBeenCalled();
      expect(deps.plans).not.toHaveBeenCalled();
    }
  });
  it('requires an identity binding even if an unsigned directory name matches a local home', async () => {
    const deps = dependencies();
    deps.projects = vi.fn().mockResolvedValue([{ slug: directory.potId, harness_kind: 'hive' }]);
    const result = await buildDaoWorkspaceView('w', { ...directory, hivePubkey: null }, deps);
    expect(result.status).toBe('not-joined');
    expect(deps.members).not.toHaveBeenCalled();
  });
  it('preserves governance integrity errors instead of showing unqualified approval', async () => {
    const deps = dependencies();
    deps.governance = vi.fn().mockResolvedValue({ potId: 'owner-home', events: [], integrityErrors: ['invalid signature'], conflictedRoundIds: new Set(['round-a']) });
    const result = await buildDaoWorkspaceView('w', directory, deps);
    expect(result.governance).toEqual({ status: 'ready', value: { events: [], integrityErrors: ['invalid signature'], conflictedRoundIds: ['round-a'] } });
  });
  it('reads the owner policy rather than a different policy under a colliding local name', async () => {
    const deps = dependencies();
    deps.policy = vi.fn().mockImplementation(async (_workspace, slug) => ({ policyVersion: slug === 'owner-home' ? 42 : 7,
      policy: { membership: slug === 'owner-home' ? 'allowlist' : 'open' } }));
    const result = await buildDaoWorkspaceView('w', directory, deps);
    expect(deps.policyScope).toHaveBeenCalledWith('w', 'local-renamed');
    expect(deps.policy).toHaveBeenCalledWith('w', 'owner-home');
    expect(result.policy).toMatchObject({ status: 'ready', value: { version: 42, membership: 'allowlist' } });
  });
});
