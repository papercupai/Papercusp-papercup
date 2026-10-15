import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildHiveDirectoryRows } from './discovery-hive-rows';
const fixture = vi.hoisted(() => ({ discovered: [] as unknown[], projects: [] as unknown[], hives: new Map<string, unknown>(), workspaces: [] as unknown[], registryError: null as Error | null }));
vi.mock('./hive-directory-deps', () => ({ getHiveDirectory: () => ({ listDiscoveredHives: () => fixture.discovered }) }));
vi.mock('./harness-registry', () => ({ loadHarnessRegistry: async () => ({ projects: fixture.projects }) }));
vi.mock('./hive-store', () => ({ getHiveBySlug: async (_workspace: string, slug: string) => fixture.hives.get(slug) ?? null }));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'workspace', readRegistry: () => {
  if (fixture.registryError) throw fixture.registryError;
  return { workspaces: fixture.workspaces };
} }));
beforeEach(() => {
  fixture.workspaces = []; fixture.registryError = null;
  fixture.discovered = []; fixture.projects = [{ slug: 'owned', harness_kind: 'hive' }, { slug: 'joined', harness_kind: 'hive', remote_hive: true }, { slug: 'project', hive_slug: 'owned' }];
  fixture.hives = new Map([['owned', { pubkeyBase64: 'owned-key', title: 'Private owned DAO', createdAt: 1, updatedAt: 1 }],
    ['joined', { pubkeyBase64: 'joined-key', title: 'Joined DAO', createdAt: 1, updatedAt: 1 }]]);
});
describe('explicit local DAO directory view', () => {
  it('keeps owned and private organizations out of the default public discovery view', async () => {
    expect((await buildHiveDirectoryRows()).map(row => row.potId)).toEqual(['joined']);
  });
  it('includes workspace-owned identities only on explicit local opt-in', async () => {
    const rows = await buildHiveDirectoryRows({ includeLocalViews: true });
    expect(rows.map(row => row.potId)).toEqual(['owned', 'joined']);
    expect(rows[0]).toMatchObject({ source: 'local', title: 'Private owned DAO', memberCount: 1, memberLinks: [] });
  });
  it('deduplicates published and locally renamed views by verified identity', async () => {
    fixture.discovered = [{ potId: 'published-owner', title: 'Published DAO', description: '', ownerGithubLogin: 'owner', visibility: 'public',
      hivePubkey: 'joined-key', memberTopics: [], memberLinks: [], createdAt: 1, lastSeenMs: 1 }];
    const rows = await buildHiveDirectoryRows({ includeLocalViews: true });
    expect(rows.map(row => row.potId)).toEqual(['published-owner', 'owned']);
  });
  it('refuses to invent an owned identity from the registry name', async () => {
    fixture.hives.delete('owned');
    expect((await buildHiveDirectoryRows({ includeLocalViews: true })).map(row => row.potId)).toEqual(['joined']);
  });
  it('includes every registered standalone workspace without a DAO or hive identity on local opt-in', async () => {
    fixture.projects = []; fixture.hives.clear();
    fixture.workspaces = [{ id: 'personal', name: 'Personal work', createdAt: 10 }, { id: 'studio', name: 'Studio', createdAt: 20 }];
    const rows = await buildHiveDirectoryRows({ includeLocalViews: true });
    expect(rows.map(row => row.title)).toEqual(['Personal work', 'Studio']);
    expect(rows.map(row => row.workspaceId)).toEqual(['personal', 'studio']);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'local', hivePubkey: null, memberLinks: [], memberTopics: [] }),
    ]));
    expect(await buildHiveDirectoryRows()).toEqual([]);
  });
  it('keeps a standalone workspace distinct from a DAO with the same slug', async () => {
    fixture.workspaces = [{ id: 'owned', name: 'Independent workspace', createdAt: 10 }];
    const rows = await buildHiveDirectoryRows({ includeLocalViews: true });
    expect(rows.filter(row => row.title === 'Independent workspace')).toHaveLength(1);
    expect(new Set(rows.map(row => row.potId)).size).toBe(rows.length);
    expect(rows.find(row => row.potId === 'owned')?.hivePubkey).toBe('owned-key');
  });
  it('includes standalone workspaces even when joined DAO views are disabled', async () => {
    fixture.workspaces = [{ id: 'personal', name: 'Personal', createdAt: 10 }];
    expect(await buildHiveDirectoryRows({ includeLocalViews: true, includeJoinedRemoteViews: false })).toEqual([
      expect.objectContaining({ workspaceId: 'personal', title: 'Personal' }),
    ]);
  });
  it('surfaces an unreadable local workspace registry instead of reporting a complete empty list', async () => {
    fixture.registryError = new Error('workspace registry unreadable');
    await expect(buildHiveDirectoryRows({ includeLocalViews: true })).rejects.toThrow('workspace registry unreadable');
    await expect(buildHiveDirectoryRows()).resolves.toHaveLength(1);
  });
});
