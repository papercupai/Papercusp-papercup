import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync as fsWriteFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  controlPlaneTempCandidates,
  controlPlaneTempRoot,
  createControlPlaneTempDir,
  createControlPlaneTempDirWithFile,
  createControlPlaneTempDirAsync,
  createControlPlaneTempFile,
} from './control-plane-temp.mjs';

const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('control-plane temp roots', () => {
  const allWritable = { isUsableDirectory: () => true };
  const simulatedRoots = {
    platform: 'linux',
    runtimeDir: '/run/user/1000',
    sharedMemoryDir: '/dev/shm',
    tempDir: '/tmp/pcv',
    ...allWritable,
  };

  it('uses shared memory for payloads and XDG runtime for sockets and logs', () => {
    expect(controlPlaneTempCandidates('payload', simulatedRoots))
      .toEqual(['/dev/shm', '/run/user/1000', '/tmp/pcv']);
    expect(controlPlaneTempCandidates('socket', simulatedRoots))
      .toEqual(['/run/user/1000', '/dev/shm', '/tmp/pcv']);
    expect(controlPlaneTempCandidates('log', simulatedRoots))
      .toEqual(['/run/user/1000', '/dev/shm', '/tmp/pcv']);
    expect(controlPlaneTempRoot('payload', simulatedRoots)).toBe('/dev/shm');
    expect(controlPlaneTempRoot('socket', simulatedRoots)).toBe('/run/user/1000');
  });

  it('falls back to the OS temp root when runtime filesystems are unavailable', () => {
    expect(controlPlaneTempCandidates('payload', {
      platform: 'darwin',
      runtimeDir: null,
      tempDir: '/private/tmp',
      sharedMemoryDir: '/dev/shm',
      isUsableDirectory: (path: string) => path === '/private/tmp',
    })).toEqual(['/private/tmp']);
  });

  it('skips an overlong runtime root for socket paths while retaining shorter fallbacks', () => {
    expect(controlPlaneTempCandidates('socket', {
      ...simulatedRoots,
      runtimeDir: join('/run/user', 'r'.repeat(64)),
    })).toEqual(['/dev/shm', '/tmp/pcv']);
  });

  it('creates private directories and files on the selected root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'control-plane-temp-test-'));
    scratch.push(root);
    const options = {
      platform: 'darwin',
      runtimeDir: null,
      tempDir: root,
      sharedMemoryDir: null,
      isUsableDirectory: (path: string) => path === root,
    };

    const dir = createControlPlaneTempDir('private-dir-', 'payload', options);
    const asyncDir = await createControlPlaneTempDirAsync('private-async-', 'log', options);
    const file = createControlPlaneTempFile('private-file-', '.json', 'payload', options);
    scratch.push(dir, asyncDir, file);

    expect(dir.startsWith(root + '/')).toBe(true);
    expect(asyncDir.startsWith(root + '/')).toBe(true);
    expect(file.startsWith(root + '/')).toBe(true);
    expect(statSync(dir).mode & 0o077).toBe(0);
    expect(statSync(asyncDir).mode & 0o077).toBe(0);
    expect(statSync(file).mode & 0o077).toBe(0);
  });

  it('retries a payload write on the next root when the preferred filesystem returns ENOSPC', () => {
    const preferred = mkdtempSync(join(tmpdir(), 'control-plane-full-'));
    const fallback = mkdtempSync(join(tmpdir(), 'control-plane-fallback-'));
    scratch.push(preferred, fallback);
    const directory = createControlPlaneTempDirWithFile(
      'payload-',
      'prompt.txt',
      'large kickoff body',
      'payload',
      {
        platform: 'linux',
        runtimeDir: fallback,
        sharedMemoryDir: preferred,
        tempDir: fallback,
        isUsableDirectory: (path: string) => path === preferred || path === fallback,
        writeFileSync(
          path: string,
          contents: string | Uint8Array,
          options?: { encoding?: 'utf8'; mode?: number; flag?: string },
        ) {
          if (path.startsWith(preferred + sep)) {
            throw Object.assign(new Error('filesystem full'), { code: 'ENOSPC' });
          }
          fsWriteFileSync(path, contents, options);
        },
      },
    );

    expect(directory.startsWith(fallback + sep)).toBe(true);
    expect(readFileSync(join(directory, 'prompt.txt'), 'utf8')).toBe('large kickoff body');
    expect(readdirSync(preferred)).toEqual([]);
  });
});
