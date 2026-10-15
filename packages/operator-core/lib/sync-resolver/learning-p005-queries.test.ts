// P-005 resolver GATES (whole-app-sync-payload-audit phase2): learning.observations
// (default and filtered views → live partition-aware keyset read) and
// learning.releaseReadiness (no args → retained snapshot SELECT). The observations
// rows must use the same live partition as their companion summary.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { knownQueryNamesV2 } from './index';

const { readDerivedSnapshotRowsMock, registerDerivedReadMock, readPageMock } = vi.hoisted(() => ({
  readDerivedSnapshotRowsMock: vi.fn(async (_key: string) => [] as unknown[]),
  registerDerivedReadMock: vi.fn(),
  readPageMock: vi.fn(async () => ({
    rows: [{ id: 'EI-9', title: 'live', refs: [], createdAt: '2026-08-21T00:00:00.000Z' }],
    nextCursor: null,
    hasMore: false,
  })),
}));

vi.mock('../derived-reads/registry', () => ({
  readDerivedSnapshotRows: readDerivedSnapshotRowsMock,
  registerDerivedRead: registerDerivedReadMock,
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: {} }),
}));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('../issues-engineer', () => ({
  resolveIssuesScopeWorkspace: () => 'ws-test',
}));
vi.mock('./learning-observations-read', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./learning-observations-read')>()),
  readLearningObservationsPageFromStore: readPageMock,
}));

describe('P-005 resolver gates', () => {
  it('registers the row, summary, and retained snapshot query names', () => {
    const names = knownQueryNamesV2();
    expect(names).toContain('learning.observations');
    expect(names).toContain('learning.observations.summary');
    expect(names).toContain('learning.releaseReadiness');
  });

  describe('routing', () => {
    beforeEach(() => {
      vi.resetModules();
      readDerivedSnapshotRowsMock.mockClear();
      readPageMock.mockClear();
    });
    afterEach(() => vi.resetModules());

    it('learning.observations DEFAULT view (limit 200) reads the live partition rather than retained stock', async () => {
      const snap = [{ id: 'EI-1', title: 'snapshot', body: 'x', refs: [], createdAt: '2026-08-21T00:00:00.000Z' }];
      readDerivedSnapshotRowsMock.mockImplementation(async () => snap);
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('learning.observations', { limit: 200 })) as unknown[];
      expect(rows).toMatchObject([{ id: 'EI-9', title: 'live' }]);
      expect(readDerivedSnapshotRowsMock).not.toHaveBeenCalled();
      expect(readPageMock).toHaveBeenCalledWith(
        expect.anything(),
        'ws-test',
        expect.objectContaining({ args: expect.objectContaining({ limit: 200 }) }),
      );
    });

    it('learning.observations with a state filter falls through to the live keyset reader', async () => {
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('learning.observations', { state: 'resolved', limit: 200 })) as unknown[];
      expect(rows).toHaveLength(1);
      expect(readDerivedSnapshotRowsMock).not.toHaveBeenCalled();
      expect(readPageMock).toHaveBeenCalledWith(
        expect.anything(),
        'ws-test',
        expect.objectContaining({
          args: expect.objectContaining({ state: 'resolved' }),
        }),
      );
    });

    it('learning.releaseReadiness (no args) reads the snapshot', async () => {
      const snap = [{ ready: true }];
      readDerivedSnapshotRowsMock.mockImplementation(async () => snap);
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('learning.releaseReadiness', {})) as unknown[];
      expect(rows).toBe(snap);
      expect(readDerivedSnapshotRowsMock).toHaveBeenCalledWith('learning.releaseReadiness');
    });
  });
});
