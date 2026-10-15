import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sidecar = vi.hoisted(() => ({
  enabled: true,
  enabledVar: vi.fn(),
  run: vi.fn(),
  fallback: vi.fn(),
  localSpawn: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    spawn: (...args: Parameters<typeof original.spawn>) => {
      sidecar.localSpawn(...args);
      return original.spawn(...args);
    },
  };
});

vi.mock('../../fleet/git-via-sidecar', () => ({
  gitSidecarEnabled: (explicitVar?: string) => {
    sidecar.enabledVar(explicitVar);
    return sidecar.enabled;
  },
  isSidecarInfrastructureFault: (result: { code: number; stderr: string }) =>
    result.code === -1 && result.stderr.startsWith('spawner sidecar '),
  noteSidecarFallback: (...args: unknown[]) => sidecar.fallback(...args),
  runGitStdinViaSpawnerSidecar: (...args: unknown[]) => sidecar.run(...args),
}));

import { defaultBlobBatchReader } from './committed-tree-reader';

const BLOB_PATH = 'src/binary.dat';
const CONTENT = Buffer.from([0x00, 0x61, 0xff, 0x0a, 0x80, 0x5a]);

let repoDir = '';

function git(...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-C', repoDir,
      '-c', 'user.email=t@example.test',
      '-c', 'user.name=t',
      '-c', 'commit.gpgsign=false',
      ...args,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

function catFileBatch(blobId: string, content: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`${blobId} blob ${content.length}\n`),
    content,
    Buffer.from('\n'),
  ]);
}

beforeEach(() => {
  sidecar.enabled = true;
  sidecar.enabledVar.mockReset();
  sidecar.run.mockReset();
  sidecar.fallback.mockReset();
  sidecar.localSpawn.mockReset();

  repoDir = mkdtempSync(join(tmpdir(), 'committed-tree-sidecar-'));
  git('init', '-q', '-b', 'main');
  mkdirSync(join(repoDir, 'src'), { recursive: true });
  writeFileSync(join(repoDir, BLOB_PATH), CONTENT);
  git('add', '.');
  git('commit', '-q', '-m', 'binary fixture');
});

afterEach(() => {
  if (repoDir) rmSync(repoDir, { recursive: true, force: true });
  repoDir = '';
});

describe('committed-tree blob reader sidecar routing', () => {
  it('reads uncached binary blobs through the spawner sidecar when enabled', async () => {
    const blobId = git('rev-parse', `HEAD:${BLOB_PATH}`);
    sidecar.run.mockResolvedValue({ code: 0, stdout: catFileBatch(blobId, CONTENT), stderr: '' });

    const blobs = await defaultBlobBatchReader(repoDir, [blobId]);

    expect(blobs.get(blobId)).toEqual(CONTENT);
    expect(sidecar.enabledVar).toHaveBeenCalledWith('PAPERCUSP_PLAN_AUDIT_SPAWN_SIDECAR');
    expect(sidecar.run).toHaveBeenCalledWith(
      ['cat-file', '--batch'],
      repoDir,
      `${blobId}\n`,
      15_000,
      process.env,
    );
    expect(sidecar.fallback).not.toHaveBeenCalled();
    expect(sidecar.localSpawn).not.toHaveBeenCalled();
  });

  it('rejects an RPC timeout with its original identity without spawning locally or blocking a loop turn', async () => {
    const blobId = git('rev-parse', `HEAD:${BLOB_PATH}`);
    const sidecarError = new Error('RPC request timeout:process:exec');
    let rejectRpc!: (error: Error) => void;
    sidecar.run.mockImplementation(() => new Promise((_resolve, reject) => { rejectRpc = reject; }));
    const result = defaultBlobBatchReader(repoDir, [blobId]).then(
      () => ({ error: null }),
      (error: unknown) => ({ error }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sidecar.localSpawn).not.toHaveBeenCalled();
    rejectRpc(sidecarError);
    expect((await result).error).toBe(sidecarError);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sidecar.localSpawn).not.toHaveBeenCalled();
    expect(sidecar.fallback).toHaveBeenCalledWith('committed-tree-reader', sidecarError, undefined, 'rejected');
  });

  it('rejects sidecar infrastructure failure without replacing it with a local read', async () => {
    const blobId = git('rev-parse', `HEAD:${BLOB_PATH}`);
    sidecar.run.mockResolvedValue({ code: -1, stdout: Buffer.alloc(0), stderr: 'spawner sidecar handoff failed' });
    await expect(defaultBlobBatchReader(repoDir, [blobId])).rejects.toThrow('spawner sidecar handoff failed');
    expect(sidecar.localSpawn).not.toHaveBeenCalled();
    expect(sidecar.fallback).toHaveBeenNthCalledWith(
      1,
      'committed-tree-reader',
      expect.objectContaining({ message: 'spawner sidecar handoff failed' }),
      undefined,
      'rejected',
    );
  });

  it('preserves a real Git failure instead of retrying locally or reporting empty blobs', async () => {
    sidecar.run.mockResolvedValue({ code: 128, stdout: Buffer.alloc(0), stderr: 'fatal: not a git repository' });
    await expect(defaultBlobBatchReader(repoDir, ['a'.repeat(40)])).rejects.toThrow(
      `Command failed (exit 128): git -C ${repoDir} cat-file --batch\nfatal: not a git repository`,
    );
    expect(sidecar.localSpawn).not.toHaveBeenCalled();
    expect(sidecar.fallback).not.toHaveBeenCalled();
  });

  it('reads a cold binary blob locally only when the sidecar route is deliberately disabled', async () => {
    sidecar.enabled = false;
    const blobId = git('rev-parse', `HEAD:${BLOB_PATH}`);
    const blobs = await defaultBlobBatchReader(repoDir, [blobId]);
    expect(blobs.get(blobId)).toEqual(CONTENT);
    expect(sidecar.run).not.toHaveBeenCalled();
    expect(sidecar.localSpawn).toHaveBeenCalledTimes(1);
    expect(sidecar.fallback).not.toHaveBeenCalled();
  });

  it.each([
    { code: 'ETIMEDOUT', signal: 'SIGTERM', killed: true },
    { code: null, signal: 'SIGTERM', killed: false },
  ])('preserves a missing exit status with its distinct termination metadata: %j', async (error) => {
    sidecar.run.mockResolvedValue({ code: -1, stdout: Buffer.alloc(0), stderr: 'child stopped', error });
    await expect(defaultBlobBatchReader(repoDir, ['a'.repeat(40)])).rejects.toMatchObject({
      ...error,
      message: `Command failed (no exit status; code=${error.code ?? 'none'}, signal=SIGTERM, killed=${error.killed}): git -C ${repoDir} cat-file --batch\nchild stopped`,
    });
    expect(sidecar.localSpawn).not.toHaveBeenCalled();
    expect(sidecar.fallback).not.toHaveBeenCalled();
  });

  it('preserves typed infrastructure failure while rejecting the enabled sidecar route', async () => {
    const error = { code: 'SIDECAR_SETTLEMENT_FAILED', signal: null, killed: false };
    sidecar.run.mockResolvedValue({ code: -1, stdout: Buffer.alloc(0), stderr: 'spawner sidecar settlement failed', error });
    await expect(defaultBlobBatchReader(repoDir, ['a'.repeat(40)])).rejects.toMatchObject(error);
    expect(sidecar.localSpawn).not.toHaveBeenCalled();
    expect(sidecar.fallback).toHaveBeenCalledWith('committed-tree-reader', expect.objectContaining(error), undefined, 'rejected');
  });
});
