/**
 * The disk consumer census lists a max-depth directory's own files through ONE find
 * subprocess, run with the walk's privilege (disk-headroom-standing-reclaim-2026-10-12
 * P-001, R-1; WI-6554700010009487).
 *
 * Measured 2026-10-12: the previous lister awaited one lstat per entry on bg-host's event
 * loop at ~106 entries/s, so one 427,868-file directory on /mnt/data held the device's
 * row back ~67 min after its du walk had finished; the same listing through find took
 * 15 s. It also ran unprivileged under a root walk.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildDeviceConsumers,
  type CensusDevice,
  type CensusSpawn,
  censusPhaseNote,
  type CensusSql,
  type DuRun,
  listOwnFiles,
  type OwnFilesListing,
  runDiskConsumerCensusOnce,
} from './disk-consumer-census';

const KIB = 1024;
const GIB = 1024 ** 3;

/** A child process stand-in: stdout/stderr streams, `close` only after both have ended. */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: string[] = [];
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    void this.finish(null);
    return true;
  }
  async finish(code: number | null): Promise<void> {
    const ended = Promise.all([once(this.stdout, 'end'), once(this.stderr, 'end')]);
    this.stdout.end();
    this.stderr.end();
    await ended;
    this.emit('close', code);
  }
}

function fakeSpawn(script: (child: FakeChild) => void): { spawn: CensusSpawn; calls: Array<[string, string[]]> } {
  const calls: Array<[string, string[]]> = [];
  return {
    calls,
    spawn: (cmd, args) => {
      calls.push([cmd, args]);
      const child = new FakeChild();
      setImmediate(() => script(child));
      return child as unknown as ReturnType<CensusSpawn>;
    },
  };
}

describe.runIf(process.platform === 'linux')('listOwnFiles over a real directory', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'census-own-files-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns only the immediate regular files at or above the floor, from a single subprocess', async () => {
    for (let i = 0; i < 300; i++) writeFileSync(join(dir, `small-${i}.json`), '{}');
    const big = join(dir, 'a big file.bin');
    writeFileSync(big, randomBytes(256 * KIB));
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'nested-big.bin'), randomBytes(256 * KIB));
    symlinkSync(big, join(dir, 'link-to-big'));

    const calls: Array<[string, string[]]> = [];
    const counting: CensusSpawn = (cmd, args) => {
      calls.push([cmd, args]);
      return spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    };
    const listing = await listOwnFiles(dir, { floorBytes: 128 * KIB, sudo: null, spawn: counting });

    // One subprocess for the whole directory — never one stat per entry on the event loop.
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toContain('find');
    // ALLOCATED bytes (du's unit), not the apparent size.
    expect(listing).toEqual({ files: [{ path: big, bytes: Number(lstatSync(big).blocks) * 512 }] });
  });

  it('lists an empty directory as empty and a missing one as an incomplete listing', async () => {
    expect(await listOwnFiles(dir, { floorBytes: 0, sudo: null })).toEqual({ files: [] });
    const missing = await listOwnFiles(join(dir, 'gone'), { floorBytes: 0, sudo: null });
    expect(missing.files).toEqual([]);
    expect(missing.error).toMatch(/^find exited 1: .*gone/);
  });
});

describe('listOwnFiles subprocess contract', () => {
  it('runs find through sudo -n when the walk was privileged, and keeps only records at or above the floor', async () => {
    const { spawn, calls } = fakeSpawn((child) => {
      // Records split across chunks, one malformed, one below the floor.
      child.stdout.write('4194304 /mnt/data/x/dump one.bin\0');
      child.stdout.write('8 /mnt/data/x/tiny.json\0garb');
      child.stdout.write('age\0' + '2097152 /mnt/data/x/two.bin\0');
      void child.finish(0);
    });
    const listing = await listOwnFiles('/mnt/data/x', { floorBytes: GIB, sudo: '/usr/bin/sudo', spawn });

    expect(calls).toHaveLength(1);
    const [cmd, args] = calls[0]!;
    expect(cmd).toBe('/usr/bin/sudo');
    expect(args.slice(0, 2)).toEqual(['-n', '--']);
    expect(args.slice(args.indexOf('find'))).toEqual(['find', '/mnt/data/x', '-maxdepth', '1', '-type', 'f', '-printf', '%b %p\\0']);
    expect(listing).toEqual({
      files: [
        { path: '/mnt/data/x/dump one.bin', bytes: 2 * GIB },
        { path: '/mnt/data/x/two.bin', bytes: GIB },
      ],
    });
  });

  it('keeps what it listed and says why when find exits non-zero', async () => {
    const { spawn } = fakeSpawn((child) => {
      child.stdout.write('2097152 /mnt/data/x/kept.bin\0');
      child.stderr.write("find: '/mnt/data/x/locked': Permission denied\n");
      void child.finish(1);
    });
    const listing = await listOwnFiles('/mnt/data/x', { floorBytes: GIB, sudo: null, spawn });
    expect(listing.files).toEqual([{ path: '/mnt/data/x/kept.bin', bytes: GIB }]);
    expect(listing.error).toBe("find exited 1: find: '/mnt/data/x/locked': Permission denied");
  });

  it('kills a find that outlives its bound and reports the listing as timed out', async () => {
    let child: FakeChild | undefined;
    const { spawn } = fakeSpawn((c) => {
      child = c;
      c.stdout.write('2097152 /mnt/data/x/early.bin\0');
    });
    const listing = await listOwnFiles('/mnt/data/x', { floorBytes: GIB, sudo: null, timeoutMs: 30, spawn });
    expect(child?.signals).toEqual(['SIGTERM']);
    expect(listing).toEqual({ files: [{ path: '/mnt/data/x/early.bin', bytes: GIB }], error: 'find timed out after 0 s' });
  });

  it('never throws when the subprocess cannot be started', async () => {
    const spawnFails: CensusSpawn = () => {
      throw new Error('spawn find ENOENT');
    };
    expect(await listOwnFiles('/mnt/data/x', { floorBytes: GIB, sudo: null, spawn: spawnFails })).toEqual({
      files: [],
      error: 'find failed: spawn find ENOENT',
    });
  });
});

const device: CensusDevice = { device: '/mnt/x', majorMinor: '259:0', sizeBytes: 1000 * GIB, usedBytes: 500 * GIB, availBytes: 500 * GIB };

function duWithOwnFiles(): DuRun {
  return {
    summary: {
      rootBytes: 400 * GIB,
      consumers: [],
      ownFiles: [{ dir: '/mnt/x/a/b', depth: 2, bytes: 5 * GIB }],
      records: 3,
    },
    deniedCount: 0,
    deniedSample: [],
    timedOut: false,
    exitCode: 0,
    privileged: true,
  };
}

describe('buildDeviceConsumers own-files attribution', () => {
  it('lists with the walk privilege, splits big files from the remainder, and notes a partial listing', async () => {
    const seen: Array<{ dir: string; sudo: string | null | undefined; floorBytes: number }> = [];
    const lister = async (dir: string, opts: { floorBytes: number; sudo?: string | null }): Promise<OwnFilesListing> => {
      seen.push({ dir, sudo: opts.sudo, floorBytes: opts.floorBytes });
      return { files: [{ path: '/mnt/x/a/b/dump.bin', bytes: 3 * GIB }], error: 'find exited 1: denied' };
    };
    const out = await buildDeviceConsumers(device, duWithOwnFiles(), [], GIB, { sudo: '/usr/bin/sudo', listOwnFiles: lister });

    expect(seen).toEqual([{ dir: '/mnt/x/a/b', sudo: '/usr/bin/sudo', floorBytes: GIB }]);
    expect(out.consumers).toEqual(
      expect.arrayContaining([
        { consumer: '/mnt/x/a/b/dump.bin', kind: 'file', depth: 3, bytes: 3 * GIB },
        expect.objectContaining({ kind: 'files', depth: 3, bytes: 2 * GIB }),
      ]),
    );
    expect(out.ownFilesNotes).toEqual(['own files of /mnt/x/a/b may be incomplete (find exited 1: denied)']);
  });
});

describe('runDiskConsumerCensusOnce own-files listing', () => {
  function fakeSql(): CensusSql {
    const sql = (async () => []) as unknown as CensusSql;
    (sql as { begin: CensusSql['begin'] }).begin = async (fn) => fn(sql);
    return sql;
  }

  it('passes the probed sudo to the own-files lister', async () => {
    const sudos: Array<string | null | undefined> = [];
    const result = await runDiskConsumerCensusOnce({
      sql: fakeSql(),
      host: 'own-files-test',
      devices: [device],
      measurePostgres: async () => null,
      measureDocker: async () => null,
      resolveSudo: async () => '/usr/bin/sudo',
      statDevice: null,
      runDu: async () => duWithOwnFiles(),
      listOwnFiles: async (_dir, opts) => {
        sudos.push(opts.sudo);
        return { files: [] };
      },
      now: () => new Date('2026-10-12T21:00:00Z'),
    });
    expect(result.failures).toEqual([]);
    expect(sudos).toEqual(['/usr/bin/sudo']);
  });
});

describe('censusPhaseNote', () => {
  it('names each phase in seconds so a slow phase is visible on the run row', () => {
    expect(censusPhaseNote(2_412_300, 15_049, 3)).toBe('phases: walk 2412.3 s, attribution 15.0 s (3 own-files dir(s))');
  });
});
