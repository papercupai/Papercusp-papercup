import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { resolveExternalPathLockIdentity } from '../agent-tools/locks/external-path';

const lockMocks = vi.hoisted(() => ({
  tryAcquire: vi.fn(),
  tryRelease: vi.fn(),
  inWorkspaceTxn: vi.fn(),
  routeFileLockOp: vi.fn(),
  emitAcquireLockEvents: vi.fn(),
  emitReleaseLockEvents: vi.fn(),
  recordLockEvent: vi.fn(),
}));

vi.mock('../agent-tools/locks/su-lock-store', () => ({
  normalizePaths: (paths: string[]) => Array.from(new Set(paths)).sort(),
  tryAcquire: lockMocks.tryAcquire,
  tryRelease: lockMocks.tryRelease,
}));
vi.mock('../agent-tools/locks/in-workspace-txn', () => ({
  inWorkspaceTxn: lockMocks.inWorkspaceTxn,
}));
vi.mock('../agent-tools/locks/coordination-domain', () => ({
  fileLockCoordinationDomain: () => '/repo/papercusp',
}));
vi.mock('../authority/file-lock-routing', () => ({
  routeFileLockOp: lockMocks.routeFileLockOp,
}));
vi.mock('../authority/file-lock-authority-ops', () => ({
  FILE_LOCK_OP_KINDS: { acquire: 'lock.acquire', release: 'lock.release' },
  emitAcquireLockEvents: lockMocks.emitAcquireLockEvents,
  emitReleaseLockEvents: lockMocks.emitReleaseLockEvents,
}));
vi.mock('../authority/lock-event-stream', () => ({
  recordLockEvent: lockMocks.recordLockEvent,
}));

import { withHookInstallLock } from './hook-install-lock';

let home: string;
let heldPaths: string[];

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'hook-install-lock-'));
  heldPaths = [];
  lockMocks.tryAcquire.mockReset();
  lockMocks.tryRelease.mockReset();
  lockMocks.inWorkspaceTxn.mockReset();
  lockMocks.routeFileLockOp.mockReset();
  lockMocks.emitAcquireLockEvents.mockReset();
  lockMocks.emitReleaseLockEvents.mockReset();
  lockMocks.recordLockEvent.mockReset();
  lockMocks.tryAcquire.mockImplementation(async (_tx: unknown, params: { paths: string[] }) => {
    heldPaths = params.paths;
    return {
      ok: true,
      lock_id: 'hook-install-lock-id',
      expires_ts: new Date(Date.now() + 600_000),
      held: params.paths,
      newly_held: params.paths,
    };
  });
  lockMocks.tryRelease.mockImplementation(async () => ({
    released: heldPaths,
    heldBefore: heldPaths.length,
  }));
  lockMocks.inWorkspaceTxn.mockImplementation(
    async (_domain: string, _owner: string, callback: (tx: unknown) => Promise<unknown>) =>
      callback({}),
  );
  lockMocks.routeFileLockOp.mockImplementation(
    async (_domain: string, operation: { local: () => Promise<unknown> }) => ({
      value: await operation.local(),
      via: 'local-authority',
      scope: 'papercusp',
    }),
  );
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('withHookInstallLock', () => {
  it('uses the shared external-path identities and skips writes while another holder owns them', async () => {
    lockMocks.tryAcquire.mockResolvedValueOnce({
      ok: false,
      busy: [{
        path: '@external/home/.papercusp/hooks/inject',
        owner: 'agent-holding-hook-files',
        owner_label: 'agent',
        intent: 'editing installed hooks',
        expires_ts: new Date(Date.now() + 60_000),
      }],
    });
    const operation = vi.fn(async () => 'written');

    const result = await withHookInstallLock(home, operation);

    const expectedPaths = ['inject', 'omp']
      .map((family) => resolveExternalPathLockIdentity(
        path.join(home, '.papercusp', 'hooks', family),
        { home },
      ).path)
      .sort();
    expect(result).toEqual({
      acquired: false,
      reason: 'held by agent-holding-hook-files at @external/home/.papercusp/hooks/inject',
    });
    expect(operation).not.toHaveBeenCalled();
    expect(lockMocks.tryAcquire).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        coordinationDomain: '/repo/papercusp',
        paths: expectedPaths,
        automatic: true,
      }),
    );
    expect(lockMocks.tryRelease).not.toHaveBeenCalled();
  });

  it('releases the shared claim after the complete installation callback', async () => {
    const operation = vi.fn(async () => 'installed');

    const result = await withHookInstallLock(home, operation);

    expect(result).toEqual({ acquired: true, value: 'installed' });
    expect(lockMocks.tryAcquire).toHaveBeenCalledTimes(1);
    expect(lockMocks.tryRelease).toHaveBeenCalledTimes(1);
    const acquireParams = lockMocks.tryAcquire.mock.calls[0][1];
    const releaseParams = lockMocks.tryRelease.mock.calls[0][1];
    expect(releaseParams).toMatchObject({
      coordinationDomain: acquireParams.coordinationDomain,
      owner: acquireParams.owner,
      lockId: 'hook-install-lock-id',
    });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('releases the claim even when installation fails', async () => {
    const operation = vi.fn(async () => {
      throw new Error('copy failed');
    });

    await expect(withHookInstallLock(home, operation)).rejects.toThrow('copy failed');
    expect(lockMocks.tryRelease).toHaveBeenCalledTimes(1);
  });
});
