/**
 * resolveCensusSudo — when the disk consumer census walks as root
 * (disk-headroom-standing-reclaim-2026-10-12 P-001, R-1; WI-6554700010008933).
 *
 * A stub `sudo` on a private PATH stands in for the real binary, so the default
 * probe (`sudo -n true`) runs for real without needing real privilege.
 */
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, promises as fsp, rmSync, writeFileSync } from 'node:fs';
import { request, type ClientRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectRetentionTrees, measureDocker, resolveCensusSudo, type CensusSpawn } from './disk-consumer-census';

vi.mock('node:http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:http')>()),
  request: vi.fn(),
}));

const isRoot = process.getuid?.() === 0;

describe('streaming retention census evidence', () => {
  it('measures recent foreign-owned bytes under explicit sudo and retains special trees', async () => {
    const root = mkdtempSync(join(tmpdir(), 'retention-full-'));
    const info = await fsp.lstat(root);
    const spawn = ((command: string, args: string[]) => {
      expect(command).toBe('/usr/bin/sudo'); expect(args.slice(0, 2)).toEqual(['-n', '--']);
      expect(args).not.toContain('-uid'); expect(args).not.toContain('-newermt');
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
      queueMicrotask(() => {
        const row = (type: string, name: string, blocks: string) => [type, String(info.dev), '1', '2000000000.0', '2000000000.0', blocks, '99999', join(root, name), ''].join('\0');
        child.stdout.write(row('f', 'recent', '4') + row('d', 'special', '1') + row('p', 'special/fifo', '0'));
        child.emit('close', 0);
      });
      return child;
    }) as unknown as CensusSpawn;
    try {
      const result = await inspectRetentionTrees(root, { retainAfterMs: 1, includeRecent: true, sudo: '/usr/bin/sudo', spawn });
      expect(result.error).toBeUndefined();
      expect(result.entries).toEqual([expect.objectContaining({ path: join(root, 'recent'), bytes: 2048 })]);
      expect(result.retained).toEqual([expect.objectContaining({ reason: 'special filesystem entry', entry: expect.objectContaining({ bytes: 512 }) })]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each([
    ['1792019778.0253824420', 1792019778025.3823],
    ['1792019778.0263825090', 1792019778026.3826],
    ['-0.5000000000', -500],
  ])('keeps the lstat millisecond identity of native timestamp %s', async (timestamp, expectedMs) => {
    const root = mkdtempSync(join(tmpdir(), 'retention-timestamp-'));
    const info = await fsp.lstat(root);
    const spawn = (() => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
      queueMicrotask(() => {
        child.stdout.write(['f', String(info.dev), '1', timestamp, timestamp, '1', String(process.getuid?.() ?? 0), join(root, 'unchanged'), ''].join('\0'));
        child.emit('close', 0);
      });
      return child;
    }) as unknown as CensusSpawn;
    try {
      const census = await inspectRetentionTrees(root, { retainAfterMs: 2_000_000_000_000, spawn });
      expect(census.error).toBeUndefined();
      expect(census.entries).toEqual([expect.objectContaining({ path: join(root, 'unchanged'), newestWriteMs: expectedMs })]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['1e3', '1.1234567891', 'NaN'])('refuses an invalid native timestamp %s', async (timestamp) => {
    const root = mkdtempSync(join(tmpdir(), 'retention-timestamp-invalid-'));
    const info = await fsp.lstat(root);
    const spawn = (() => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
      queueMicrotask(() => {
        child.stdout.write(['f', String(info.dev), '1', timestamp, '1.0', '1', String(process.getuid?.() ?? 0), join(root, 'unknown'), ''].join('\0'));
        child.emit('close', 0);
      });
      return child;
    }) as unknown as CensusSpawn;
    try {
      const census = await inspectRetentionTrees(root, { retainAfterMs: 2_000_000_000_000, spawn });
      expect(census.error).toBe('incomplete retention metadata records');
      expect(census.entries).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('lets a large advancing native census finish and tolerates concurrent readdir disappearance only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'retention-progress-'));
    const info = await fsp.lstat(root);
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    let started!: () => void; const launched = new Promise<void>((resolve) => { started = resolve; });
    const spawn = ((_command: string, args: string[]) => {
      expect(args).toContain('-ignore_readdir_race'); started(); return child;
    }) as unknown as CensusSpawn;
    vi.useFakeTimers();
    try {
      const census = inspectRetentionTrees(root, { retainAfterMs: Date.now(), progressTimeoutMs: 25, spawn });
      await launched;
      const record = (name: string) => ['f', String(info.dev), '1', '1.0', '1.0', '1', String(process.getuid?.() ?? 0), join(root, name), ''].join('\0');
      child.stdout.write(record('first')); await vi.advanceTimersByTimeAsync(20);
      child.stdout.write(record('second')); await vi.advanceTimersByTimeAsync(20);
      child.stdout.write(record('third')); await vi.advanceTimersByTimeAsync(20);
      child.emit('close', 0);
      const result = await census;
      expect(result.error).toBeUndefined(); expect(result.entries).toHaveLength(3);
      expect(child.kill).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses truncated and malformed metadata instead of selecting a partial tree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'retention-metadata-'));
    const spawn = ((_command: string, _args: string[]) => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
      queueMicrotask(() => { child.stdout.write('f\0not-a-device\0'); child.emit('close', 0); });
      return child;
    }) as unknown as CensusSpawn;
    try {
      const census = await inspectRetentionTrees(root, { retainAfterMs: Date.now(), spawn });
      expect(census.error).toBe('incomplete retention metadata records');
      expect(census.entries).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('kills a timed-out native walk and refuses the incomplete candidate set', async () => {
    const root = mkdtempSync(join(tmpdir(), 'retention-timeout-'));
    const kill = vi.fn();
    const spawn = ((_command: string, _args: string[]) => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill });
      kill.mockImplementation(() => { child.emit('close', null); return true; });
      return child;
    }) as unknown as CensusSpawn;
    try {
      const census = await inspectRetentionTrees(root, { retainAfterMs: Date.now(), timeoutMs: 1, spawn });
      expect(census.error).toBe('retention native census timed out');
      expect(census.entries).toEqual([]); expect(kill).toHaveBeenCalledWith('SIGKILL');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('resolveCensusSudo', () => {
  let dir: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'census-sudo-'));
    savedPath = process.env.PATH;
    process.env.PATH = dir;
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  });

  function stubSudo(exitCode: number): string {
    const bin = join(dir, 'sudo');
    writeFileSync(bin, `#!/bin/sh\n[ "$1" = "-n" ] || exit 9\nexit ${exitCode}\n`);
    chmodSync(bin, 0o755);
    return bin;
  }

  it.skipIf(isRoot)('returns the sudo binary when `sudo -n true` succeeds', async () => {
    const bin = stubSudo(0);
    expect(await resolveCensusSudo()).toBe(bin);
  });

  it.skipIf(isRoot)('falls back to an unprivileged walk when sudo needs a password or is refused', async () => {
    // `sudo -n` exits 1 instead of prompting when no NOPASSWD rule applies (or under NoNewPrivileges).
    stubSudo(1);
    expect(await resolveCensusSudo()).toBeNull();
  });

  it.skipIf(isRoot)('does not probe when sudo is not installed', async () => {
    const probe = vi.fn(async () => true);
    expect(await resolveCensusSudo(probe)).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  it('never elevates a process that is already root', async () => {
    stubSudo(0);
    const probe = vi.fn(async () => true);
    const getuid = vi.spyOn(process, 'getuid').mockReturnValue(0);
    try {
      expect(await resolveCensusSudo(probe)).toBeNull();
      expect(probe).not.toHaveBeenCalled();
    } finally {
      getuid.mockRestore();
    }
  });
});

describe('measureDocker response deadlines', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(fsp, 'access').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.mocked(request).mockReset();
  });

  // The engine's disk-usage walk can legitimately exceed 20 seconds. Model the
  // HTTP client's timeout and a delayed response independently of the reader.
  function engineWithDiskUsageDelay(delayMs: number): void {
    vi.mocked(request).mockImplementation((options, onResponse) => {
      const opts = options as RequestOptions;
      const req = new EventEmitter();
      let responseTimer: ReturnType<typeof setTimeout>;
      let deadlineTimer: ReturnType<typeof setTimeout>;
      Object.assign(req, {
        end() {
          deadlineTimer = setTimeout(() => req.emit('timeout'), Number(opts.timeout));
          responseTimer = setTimeout(() => {
            clearTimeout(deadlineTimer);
            const res = new EventEmitter();
            Object.assign(res, { statusCode: 200, setEncoding() {} });
            (onResponse as unknown as ((res: IncomingMessage) => void) | undefined)?.(res as IncomingMessage);
            res.emit('data', JSON.stringify(opts.path === '/info'
              ? { DockerRootDir: '/fixture/docker' }
              : {
                  LayersSize: 64,
                  Containers: [{ SizeRw: 2 }, { SizeRw: 3 }],
                  Volumes: [{ UsageData: { Size: 80 } }],
                  BuildCache: [{ Size: 7 }],
                }));
            res.emit('end');
          }, opts.path === '/info' ? 0 : delayMs);
        },
        destroy(error: Error) {
          clearTimeout(responseTimer);
          clearTimeout(deadlineTimer);
          req.emit('error', error);
        },
      });
      return req as ClientRequest;
    });
  }

  it('accepts a valid Docker disk-usage response after the old 20-second diagnostic cutoff', async () => {
    engineWithDiskUsageDelay(25_000);
    const result = measureDocker();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await result).toEqual({
      kind: 'docker',
      rootDir: '/fixture/docker',
      parts: [
        { consumer: 'docker:images', bytes: 64 },
        { consumer: 'docker:containers', bytes: 5 },
        { consumer: 'docker:volumes', bytes: 80 },
        { consumer: 'docker:build-cache', bytes: 7 },
      ],
    });
  });

  it('reports an explicit short deadline as a timeout rather than an empty inventory', async () => {
    engineWithDiskUsageDelay(25_000);
    const result = expect(measureDocker(20_000)).rejects.toThrow('docker /system/df timed out');
    await vi.advanceTimersByTimeAsync(20_000);
    await result;
  });

  it('still bounds an unresponsive engine with the maintained default deadline', async () => {
    engineWithDiskUsageDelay(200_000);
    const result = expect(measureDocker()).rejects.toThrow('docker /system/df timed out');
    await vi.advanceTimersByTimeAsync(180_000);
    await result;
  });
});
