/**
 * WI-2037678 (P-521 J8 offline-restore): `downloadCoreRange` — used by the seed
 * RESTORE path and the cutter — must fetch `[from, length)` as ONE batched,
 * pipelined `core.download(range)`, never a sequential `await core.get(i)` per
 * block. The sequential form paid a replication round-trip per block (measured
 * 677us/block vs 149us/block batched on the dev tower), which pushed the packaged
 * offline seed restore past the installer journey's 180s budget on a QEMU guest.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Corestore from 'corestore';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCorestoreSeedProvider, downloadCoreRange } from './seed-provider-corestore';

type FakeCore = {
  length: number;
  ready: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  download: ReturnType<typeof vi.fn>;
  has: ReturnType<typeof vi.fn>;
};

function fakeStore(core: FakeCore): Corestore {
  return { get: () => core } as unknown as Corestore;
}

function makeCore(length: number, hasResult = true): FakeCore {
  return {
    length,
    ready: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    get: vi.fn(async () => null),
    download: vi.fn(() => ({ done: async () => {} })),
    has: vi.fn(async () => hasResult),
  };
}

const KEY = 'ab'.repeat(32);

/** The slice of the (loosely typed) hypercore session these tests touch. */
type TestCore = {
  readonly key: Buffer;
  readonly length: number;
  readonly contiguousLength: number;
  ready(): Promise<void>;
  append(blocks: unknown[]): Promise<unknown>;
  get(i: number): Promise<unknown>;
};

describe('downloadCoreRange — batched range fetch (WI-2037678)', () => {
  it('issues exactly one download over [from, length) and never a per-block get', async () => {
    const core = makeCore(10_000);
    const len = await downloadCoreRange(fakeStore(core), KEY, 2_500);
    expect(len).toBe(10_000);
    expect(core.download).toHaveBeenCalledTimes(1);
    expect(core.download).toHaveBeenCalledWith({ start: 2_500, end: 10_000 });
    expect(core.has).toHaveBeenCalledWith(2_500, 10_000);
    expect(core.get).not.toHaveBeenCalled();
  });

  it('downloads the whole core when from defaults to 0', async () => {
    const core = makeCore(42);
    await downloadCoreRange(fakeStore(core), KEY);
    expect(core.download).toHaveBeenCalledWith({ start: 0, end: 42 });
  });

  it('skips the download entirely for an empty range', async () => {
    const core = makeCore(5);
    expect(await downloadCoreRange(fakeStore(core), KEY, 5)).toBe(5);
    expect(core.download).not.toHaveBeenCalled();
    expect(core.get).not.toHaveBeenCalled();
  });

  it('fails loudly when the range did not fully land, instead of reporting success', async () => {
    const core = makeCore(100, false);
    await expect(downloadCoreRange(fakeStore(core), KEY, 0)).rejects.toThrow(/missing blocks in \[0, 100\)/);
  });
});

describe('corestore seed provider restore — real cores, batched path (WI-2037678)', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
  });

  it('restores every block of a multi-thousand-block seed into a fresh target store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seed-download-range-'));
    dirs.push(root);
    const seedDir = join(root, 'seed');
    const targetDir = join(root, 'target');
    const N = 3_000;

    const src = new Corestore(seedDir);
    await src.ready();
    const core = src.get({ name: 'peer-log', valueEncoding: 'json' }) as unknown as TestCore;
    await core.ready();
    const batch: unknown[] = [];
    for (let i = 0; i < N; i++) batch.push({ i });
    await core.append(batch);
    const keyHex = core.key.toString('hex');
    await src.close();

    const provider = createCorestoreSeedProvider();
    const entry = { kind: 'corestore', hash: 'unused', meta: { coreKeys: [keyHex], coreLengths: { [keyHex]: N } } };
    await provider.restore(entry as never, { path: seedDir } as never, { targetStoreDir: targetDir } as never);

    const chk = new Corestore(targetDir);
    await chk.ready();
    const restored = chk.get({ key: Buffer.from(keyHex, 'hex'), valueEncoding: 'json' }) as unknown as TestCore;
    await restored.ready();
    expect(restored.length).toBe(N);
    expect(restored.contiguousLength).toBe(N);
    expect(await restored.get(N - 1)).toEqual({ i: N - 1 });
    await chk.close();
  }, 60_000);
});
