/**
 * testing-orphan-runs (EI-5366) — orphaned test_runs row detection + prune.
 * DB-free: `sql` is injected; `loadHarnessRegistry` + `existsSync` are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const existsSyncMock = vi.fn<(p: string) => boolean>();
vi.mock('node:fs', () => ({ existsSync: (p: string) => existsSyncMock(p) }));

let registryProjects: Array<{ slug: string; path: string }>;
vi.mock('./harness-registry', () => ({
  loadHarnessRegistry: async () => ({ projects: registryProjects }),
}));

import { findOrphanTestRunGroups, pruneOrphanTestRunGroups, type OrphanRunGroup } from './testing-orphan-runs';

function fakeSql(rows: unknown[]) {
  const calls: unknown[] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('?'), values });
    return Promise.resolve(rows);
  }) as never;
  return { sql, calls };
}

beforeEach(() => {
  existsSyncMock.mockReset();
  registryProjects = [{ slug: 'papercusp', path: '/repo/papercusp' }];
});

describe('findOrphanTestRunGroups', () => {
  it('returns [] when the query has no rows', async () => {
    const { sql } = fakeSql([]);
    const out = await findOrphanTestRunGroups({ workspaceId: 'ws', sql });
    expect(out).toEqual([]);
  });

  it('flags a (harness_slug, file_path) whose file no longer exists on disk', async () => {
    const { sql } = fakeSql([
      { harness_slug: 'papercusp', file_path: 'lib/deleted.test.ts', row_count: 3 },
    ]);
    existsSyncMock.mockReturnValue(false);
    const out = await findOrphanTestRunGroups({ workspaceId: 'ws', sql });
    expect(out).toEqual<OrphanRunGroup[]>([
      { harnessSlug: 'papercusp', filePath: 'lib/deleted.test.ts', rowCount: 3, reason: 'file_not_found' },
    ]);
    expect(existsSyncMock).toHaveBeenCalledWith('/repo/papercusp/lib/deleted.test.ts');
  });

  it('does NOT flag a file that still exists', async () => {
    const { sql } = fakeSql([
      { harness_slug: 'papercusp', file_path: 'lib/still-here.test.ts', row_count: 2 },
    ]);
    existsSyncMock.mockReturnValue(true);
    const out = await findOrphanTestRunGroups({ workspaceId: 'ws', sql });
    expect(out).toEqual([]);
  });

  it('flags a row whose harness_slug has no registry entry (harness_not_found) WITHOUT touching the filesystem', async () => {
    const { sql } = fakeSql([
      { harness_slug: 'long-gone-harness', file_path: 'lib/x.test.ts', row_count: 1 },
    ]);
    const out = await findOrphanTestRunGroups({ workspaceId: 'ws', sql });
    expect(out).toEqual<OrphanRunGroup[]>([
      { harnessSlug: 'long-gone-harness', filePath: 'lib/x.test.ts', rowCount: 1, reason: 'harness_not_found' },
    ]);
    expect(existsSyncMock).not.toHaveBeenCalled();
  });

  it('handles a mix of orphaned + live files across harnesses in one scan', async () => {
    registryProjects = [
      { slug: 'papercusp', path: '/repo/papercusp' },
      { slug: 'oddsmith', path: '/repo/oddsmith' },
    ];
    const { sql } = fakeSql([
      { harness_slug: 'papercusp', file_path: 'lib/a.test.ts', row_count: 1 },
      { harness_slug: 'papercusp', file_path: 'lib/b.test.ts', row_count: 5 },
      { harness_slug: 'oddsmith', file_path: 'lib/c.test.ts', row_count: 2 },
    ]);
    existsSyncMock.mockImplementation((p: string) => p.endsWith('b.test.ts'));
    const out = await findOrphanTestRunGroups({ workspaceId: 'ws', sql });
    expect(out).toEqual<OrphanRunGroup[]>([
      { harnessSlug: 'papercusp', filePath: 'lib/a.test.ts', rowCount: 1, reason: 'file_not_found' },
      { harnessSlug: 'oddsmith', filePath: 'lib/c.test.ts', rowCount: 2, reason: 'file_not_found' },
    ]);
  });

  it('flags known non-signal path classes even when harness_slug is null', async () => {
    const { sql } = fakeSql([
      { harness_slug: null, file_path: '_retired/snapshot-system/x.test.ts', row_count: 3 },
      { harness_slug: null, file_path: '.papercusp/scratch/tdg-abc/app/x.test.ts', row_count: 4 },
      // The exact EI-10761 phantom: a flake-soak self-test fixture, null harness,
      // recorded before the reporter exclusion landed. Must classify as non-signal
      // and be prunable without a file-existence check.
      { harness_slug: null, file_path: 'apps/operator-vite/src/components/left-sidebar/MugTab.flakeproof.test.tsx', row_count: 2 },
      { harness_slug: null, file_path: 'papercupai-workspace/papercusp-checkpoint/packages/x.test.ts', row_count: 5 },
      { harness_slug: null, file_path: 'custom-install/papercusp-checkpoint/packages/y.test.ts', row_count: 7 },
      { harness_slug: null, file_path: 'packages/live.test.ts', row_count: 6 },
    ]);
    const out = await findOrphanTestRunGroups({ workspaceId: 'ws', sql });
    expect(out).toEqual<OrphanRunGroup[]>([
      { harnessSlug: null, filePath: '_retired/snapshot-system/x.test.ts', rowCount: 3, reason: 'retired_path' },
      { harnessSlug: null, filePath: '.papercusp/scratch/tdg-abc/app/x.test.ts', rowCount: 4, reason: 'scratch_path' },
      { harnessSlug: null, filePath: 'apps/operator-vite/src/components/left-sidebar/MugTab.flakeproof.test.tsx', rowCount: 2, reason: 'flakeproof_path' },
      { harnessSlug: null, filePath: 'papercupai-workspace/papercusp-checkpoint/packages/x.test.ts', rowCount: 5, reason: 'wrong_tree_path' },
      { harnessSlug: null, filePath: 'custom-install/papercusp-checkpoint/packages/y.test.ts', rowCount: 7, reason: 'wrong_tree_path' },
    ]);
    expect(existsSyncMock).not.toHaveBeenCalled();
  });
});

describe('pruneOrphanTestRunGroups', () => {
  it('is a no-op on an empty group list — never runs a query', async () => {
    const { sql, calls } = fakeSql([]);
    const deleted = await pruneOrphanTestRunGroups([], { sql });
    expect(deleted).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('deletes exactly the given groups and sums their row counts (fallback when the driver reports no count)', async () => {
    const calls: unknown[] = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join('?'), values });
      return Promise.resolve({}); // no `.count` field — exercises the rowCount fallback
    }) as never;
    const groups: OrphanRunGroup[] = [
      { harnessSlug: 'papercusp', filePath: 'lib/a.test.ts', rowCount: 3, reason: 'file_not_found' },
      { harnessSlug: 'oddsmith', filePath: 'lib/c.test.ts', rowCount: 2, reason: 'file_not_found' },
    ];
    const deleted = await pruneOrphanTestRunGroups(groups, { sql });
    expect(deleted).toBe(5);
    expect(calls).toHaveLength(2);
  });

  it('uses the driver-reported count when present, not the stale rowCount snapshot', async () => {
    let call = 0;
    const sql = ((_strings: TemplateStringsArray, ..._values: unknown[]) => {
      call += 1;
      return Promise.resolve({ count: call === 1 ? 1 : 0 }); // e.g. a row got re-inserted between scan and delete
    }) as never;
    const groups: OrphanRunGroup[] = [
      { harnessSlug: 'papercusp', filePath: 'lib/a.test.ts', rowCount: 3, reason: 'file_not_found' },
    ];
    const deleted = await pruneOrphanTestRunGroups(groups, { sql });
    expect(deleted).toBe(1);
  });

  it('deletes null-scoped phantom groups with IS NULL, not harness_slug = NULL', async () => {
    const calls: unknown[] = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join('?'), values });
      return Promise.resolve({ count: 4 });
    }) as never;
    const deleted = await pruneOrphanTestRunGroups([
      { harnessSlug: null, filePath: '.papercusp/scratch/tdg-abc/app/x.test.ts', rowCount: 4, reason: 'scratch_path' },
    ], { sql });
    expect(deleted).toBe(4);
    expect((calls[0] as { text: string }).text).toContain('harness_slug IS NULL');
  });
});
