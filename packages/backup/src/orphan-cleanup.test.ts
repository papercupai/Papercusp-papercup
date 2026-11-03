import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit coverage for the WI-1094233 fix: sweepOrphanSnapshots() reaping
 * dead-writer transaction files for every workspace it just marked
 * orphaned, instead of leaving them stranded until that workspace's next
 * scheduled hook run happens to reach `reapDeadDumpTempFiles` at its own
 * start. Full round-trip-against-real-PG coverage of the sweep's status
 * transitions already lives in
 * packages/operator-core/lib/backup/orphan-cleanup.integration.test.ts;
 * this file isolates the new reap side effect with a mocked host + a
 * mocked `./hook`, so it never touches a real filesystem or database.
 */
const h = vi.hoisted(() => ({
  sql: vi.fn(),
  workspacesRoot: '/work',
  reap: vi.fn(async () => 0),
  release: vi.fn(async () => {}),
  acquireMigrationLock: vi.fn(),
  withMigrationLock: true,
}));

vi.mock('./config', () => ({
  backupHost: () => ({
    getSql: () => h.sql,
    workspacesRoot: () => h.workspacesRoot,
    ...(h.withMigrationLock ? { acquireMigrationLock: h.acquireMigrationLock } : {}),
  }),
}));

vi.mock('./hook', () => ({
  reapDeadDumpTempFiles: h.reap,
}));

import { sweepOrphanSnapshots } from './orphan-cleanup';

function mockSweptRows(rows: Array<{ id: string; workspace_id: string }>) {
  h.sql.mockReset().mockImplementation(async () => rows);
}

describe('sweepOrphanSnapshots — reaping dead-writer temp files (WI-1094233)', () => {
  beforeEach(() => {
    h.reap.mockReset().mockResolvedValue(0);
    h.workspacesRoot = '/work';
    mockSweptRows([]);
    h.withMigrationLock = true;
    h.release.mockReset().mockResolvedValue(undefined);
    h.acquireMigrationLock.mockReset().mockResolvedValue({ release: h.release });
  });

  it('reaps once per distinct swept workspace, at the expected outPath, and sums the counts', async () => {
    mockSweptRows([
      { id: '1', workspace_id: 'ws-a' },
      { id: '2', workspace_id: 'ws-a' },
      { id: '3', workspace_id: 'ws-b' },
    ]);
    h.reap.mockResolvedValueOnce(2).mockResolvedValueOnce(1);

    const result = await sweepOrphanSnapshots();

    expect(result.swept).toBe(3);
    expect(result.sweptIds).toEqual(['1', '2', '3']);
    expect(result.reapedTempFiles).toBe(3);
    expect(h.reap).toHaveBeenCalledTimes(2);
    expect(h.reap).toHaveBeenCalledWith('/work/ws-a/db-dumps/pg-embedded.sql.gz');
    expect(h.reap).toHaveBeenCalledWith('/work/ws-b/db-dumps/pg-embedded.sql.gz');
  });

  it('does not reap anything when no rows are swept', async () => {
    mockSweptRows([]);

    const result = await sweepOrphanSnapshots();

    expect(result.swept).toBe(0);
    expect(result.reapedTempFiles).toBe(0);
    expect(h.reap).not.toHaveBeenCalled();
  });

  it('one workspace reap failure does not stop reaping the others or fail the sweep', async () => {
    mockSweptRows([
      { id: '1', workspace_id: 'ws-broken' },
      { id: '2', workspace_id: 'ws-ok' },
    ]);
    h.reap
      .mockRejectedValueOnce(new Error('EACCES'))
      .mockResolvedValueOnce(4);

    const result = await expect(sweepOrphanSnapshots()).resolves.toMatchObject({
      swept: 2,
      reapedTempFiles: 4,
    });
    void result;
    expect(h.reap).toHaveBeenCalledTimes(2);
  });
  it('defers without terminal writes or reaping when the producer rendezvous is busy', async () => {
    h.acquireMigrationLock.mockResolvedValueOnce(undefined);
    await expect(sweepOrphanSnapshots()).resolves.toEqual({ swept: 0, sweptIds: [], reapedTempFiles: 0 });
    expect(h.acquireMigrationLock).toHaveBeenCalledWith({ tryOnly: true });
    expect(h.sql).not.toHaveBeenCalled();
    expect(h.reap).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
  });

  it('does not write a verdict when producer-lock acquisition fails', async () => {
    h.acquireMigrationLock.mockRejectedValueOnce(new Error('lock session unavailable'));
    await expect(sweepOrphanSnapshots()).rejects.toThrow('lock session unavailable');
    expect(h.sql).not.toHaveBeenCalled();
    expect(h.reap).not.toHaveBeenCalled();
  });

  it('releases its producer fence when the sweep SQL fails', async () => {
    h.sql.mockRejectedValueOnce(new Error('sweep failed'));
    await expect(sweepOrphanSnapshots()).rejects.toThrow('sweep failed');
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it('holds the producer fence through the verdict and dead-writer cleanup', async () => {
    h.sql.mockImplementationOnce(async () => {
      expect(h.release).not.toHaveBeenCalled();
      return [{ id: '1', workspace_id: 'ws-a' }];
    });
    h.reap.mockImplementationOnce(async () => {
      expect(h.release).not.toHaveBeenCalled();
      return 0;
    });
    await sweepOrphanSnapshots();
    expect(h.reap).toHaveBeenCalledOnce();
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it('preserves standalone hosts without the optional producer rendezvous', async () => {
    h.withMigrationLock = false;
    await expect(sweepOrphanSnapshots()).resolves.toEqual({ swept: 0, sweptIds: [], reapedTempFiles: 0 });
    expect(h.sql).toHaveBeenCalledOnce();
    expect(h.acquireMigrationLock).not.toHaveBeenCalled();
  });
});
