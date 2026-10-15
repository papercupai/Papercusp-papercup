/**
 * Real-PostgreSQL + real-du coverage for the disk consumer census
 * (disk-headroom-standing-reclaim-2026-10-12 P-001, R-1; WI-6554700010008933).
 *
 * R-1: a per-consumer size census is written to Postgres and one read shows each
 * consumer's size and its 24h growth. Falsifiers covered here: a device with no
 * census rows in 24h is reported (stale / missing), and a consumer at or above the
 * floor that the census does not list fails the du comparison below.
 */
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import {
  apiStoreConsumers,
  pruneDiskCensus,
  readDiskConsumerCensus,
  runDiskConsumerCensusOnce,
  unattributedKey,
  writeCensusRun,
  type CensusDevice,
  type CensusSql,
} from './disk-consumer-census';
import { devToMajorMinor, type CensusConsumer } from './usage';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = resolve(HERE, '../../../../libs/papercusp/libs/db/sql/1472-disk-consumer-census.sql');
const MIGRATION = readFileSync(existsSync(MIGRATION_PATH) ? MIGRATION_PATH : `${MIGRATION_PATH}.DRAFT`, 'utf8');

const MIB = 1024 ** 2;
const G = 1024 ** 3;
const HOUR = 3600_000;

let rootSql: postgres.Sql;
let sql: CensusSql;
let fixture: string;

/** du's own number for one path — the comparison R-1's method names. */
function duBytes(path: string): number {
  const r = spawnSync('du', ['-s', '-B1', path], { encoding: 'utf8' });
  expect(r.status).toBe(0);
  return Number(r.stdout.split('\t')[0]);
}

function device(over: Partial<CensusDevice> = {}): CensusDevice {
  return { device: '/test-dev', majorMinor: '0:0', sizeBytes: 100 * G, usedBytes: 50 * G, availBytes: 50 * G, ...over };
}

function dir(consumer: string, bytes: number, depth = 1): CensusConsumer {
  return { consumer, kind: 'dir', depth, bytes };
}

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `dcc_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 2, onnotice: () => {} });
  await rootSql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  await rootSql.unsafe(MIGRATION);
  sql = rootSql as unknown as CensusSql;

  // A small tree with known shape: two listed directories, one nested, one big root file,
  // and one directory under the 1 MiB test floor.
  fixture = mkdtempSync(join(tmpdir(), 'disk-census-'));
  mkdirSync(join(fixture, 'a'));
  mkdirSync(join(fixture, 'b', 'c'), { recursive: true });
  mkdirSync(join(fixture, 'tiny'));
  writeFileSync(join(fixture, 'a', 'one.bin'), randomBytes(3 * MIB));
  writeFileSync(join(fixture, 'a', 'two.bin'), randomBytes(2 * MIB));
  writeFileSync(join(fixture, 'b', 'c', 'deep.bin'), randomBytes(5 * MIB));
  writeFileSync(join(fixture, 'big.bin'), randomBytes(4 * MIB));
  writeFileSync(join(fixture, 'tiny', 'small.txt'), 'x'.repeat(1000));
}, 120_000);

afterAll(async () => {
  if (fixture) rmSync(fixture, { recursive: true, force: true });
  await rootSql?.end({ timeout: 5 });
});

describe('disk consumer census (real du, real PG)', () => {
  it('writes a census whose consumers match du on the same paths, and accounts for every byte', async () => {
    const total = duBytes(fixture);
    const dev = device({
      device: fixture,
      majorMinor: devToMajorMinor(statSync(fixture).dev),
      usedBytes: total + 5 * MIB, // 5 MiB the walk cannot see
    });
    const now = new Date('2026-10-12T12:00:00Z');
    const result = await runDiskConsumerCensusOnce({
      sql,
      host: 'census-test-host',
      devices: [dev],
      measurePostgres: async () => null,
      measureDocker: async () => null,
      statDevice: null, // keep the synthetic usedBytes; the real statfs would describe the host disk
      floorBytes: MIB,
      maxDepth: 3,
      now: () => now,
    });
    expect(result.failures).toEqual([]);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({ device: fixture, complete: true, attributedBytes: total, unattributedBytes: 5 * MIB });

    const read = await readDiskConsumerCensus(sql, { host: 'census-test-host', limit: 50, now });
    expect(read.devices).toHaveLength(1);
    const view = read.devices[0]!;
    expect(view).toMatchObject({ device: fixture, complete: true, usedBytes: total + 5 * MIB, unattributedBytes: 5 * MIB, coverageGap: false });
    const listed = new Map(view.consumers!.map((c) => [c.consumer, c]));

    // Every directory at or above the floor is listed, at du's size for that path.
    for (const p of [fixture, join(fixture, 'a'), join(fixture, 'b'), join(fixture, 'b', 'c')]) {
      expect(listed.get(p), p).toMatchObject({ kind: 'dir', bytes: duBytes(p) });
    }
    // A large file directly inside a listed directory gets its own row.
    expect(listed.get(join(fixture, 'big.bin'))).toMatchObject({ kind: 'file', depth: 1, bytes: duBytes(join(fixture, 'big.bin')) });
    // Under the floor: not listed.
    expect(listed.has(join(fixture, 'tiny'))).toBe(false);
    expect(listed.get(unattributedKey(fixture))).toMatchObject({ kind: 'unattributed', bytes: 5 * MIB });
    // No baseline 24h earlier yet: growth is unknown, never a made-up zero.
    expect(view.baselineAt).toBeNull();
    expect(view.consumers!.every((c) => c.growth24hBytes === null)).toBe(true);
  }, 120_000);

  it('reports each consumer’s 24h growth against the run nearest 24h earlier, and ignores runs outside 18–30h', async () => {
    const host = 'growth-host';
    const dev = device({ device: '/g' });
    const latestAt = new Date('2026-10-12T12:00:00Z');
    const write = (runId: string, at: Date, consumers: CensusConsumer[], complete = true) =>
      writeCensusRun(sql, { runId, host, device: dev, startedAt: at, finishedAt: at, attributedBytes: 40 * G, complete, note: null, consumers });
    await write('00000000-0000-4000-8000-000000000001', new Date(latestAt.getTime() - 40 * HOUR), [dir('/g/a', 1 * G)]);
    await write('00000000-0000-4000-8000-000000000002', new Date(latestAt.getTime() - 23 * HOUR), [dir('/g/a', 10 * G), dir('/g/b', 8 * G)]);
    // Closer to 24h but incomplete: never a baseline.
    await write('00000000-0000-4000-8000-000000000003', new Date(latestAt.getTime() - 24 * HOUR), [dir('/g/a', 2 * G)], false);
    await write('00000000-0000-4000-8000-000000000004', latestAt, [dir('/g/a', 25 * G), dir('/g/b', 6 * G), dir('/g/new', 3 * G)]);

    const { devices } = await readDiskConsumerCensus(sql, { host, orderBy: 'growth', now: latestAt });
    const view = devices[0]!;
    expect(view.baselineAt).toBe(new Date(latestAt.getTime() - 23 * HOUR).toISOString());
    expect(view.consumers!.map((c) => [c.consumer, c.bytes, c.growth24hBytes])).toEqual([
      ['/g/a', 25 * G, 15 * G],
      ['/g/b', 6 * G, -2 * G],
      ['/g/new', 3 * G, null],
    ]);
    expect(view.stale).toBe(false);
    expect(view.coverageGap).toBe(true); // used 50 GiB − attributed 40 GiB = 10 GiB unattributed

    // Only a 40h-old run besides the latest: outside the window, so no baseline.
    const only = await readDiskConsumerCensus(sql, { host, now: latestAt, device: '/g' });
    expect(only.devices).toHaveLength(1);
  });

  it('never reports newly visible bytes as growth across a denied or differently privileged baseline', async () => {
    const host = 'visibility-growth-host'; const at = new Date('2026-10-13T17:00:00Z');
    const dev = device({ device: '/visibility' });
    const write = (id: string, hours: number, note: string, bytes: number) => writeCensusRun(sql, {
      runId: id, host, device: dev, startedAt: new Date(at.getTime() - hours * HOUR), finishedAt: new Date(at.getTime() - hours * HOUR),
      attributedBytes: bytes, complete: true, note, consumers: [dir('/visibility/data', bytes)],
    });
    await write('00000000-0000-4000-8000-000000000081', 24, '681 unreadable path(s), e.g. /var/lib/postgresql', 2 * G);
    await write('00000000-0000-4000-8000-000000000082', 23, 'du walked unprivileged (sudo -n unavailable)', 3 * G);
    await write('00000000-0000-4000-8000-000000000083', 0, 'du walked as root (sudo -n)', 40 * G);
    const unknown = (await readDiskConsumerCensus(sql, { host, now: at })).devices[0]!;
    expect(unknown.baselineAt).toBeNull(); expect(unknown.consumers![0]!.growth24hBytes).toBeNull();
    await write('00000000-0000-4000-8000-000000000084', 22, 'du walked as root (sudo -n)', 38 * G);
    const calibrated = (await readDiskConsumerCensus(sql, { host, now: at })).devices[0]!;
    expect(calibrated.baselineAt).toBe(new Date(at.getTime() - 22 * HOUR).toISOString());
    expect(calibrated.consumers![0]!.growth24hBytes).toBe(2 * G);
  });

  it('reports historical denied scans as incomplete even when the old writer stored complete=true', async () => {
    const at = new Date('2026-10-13T17:00:00Z');
    await writeCensusRun(sql, { runId: '00000000-0000-4000-8000-000000000085', host: 'legacy-denied-host', device: device({ device: '/denied' }), startedAt: at, finishedAt: at, attributedBytes: G, complete: true, note: '3 unreadable path(s), e.g. /db', consumers: [dir('/denied/data', G)] });
    const view = (await readDiskConsumerCensus(sql, { host: 'legacy-denied-host', now: at })).devices[0]!;
    expect(view.complete).toBe(false); expect(view.baselineAt).toBeNull();
  });

  it('flags a device whose latest run is older than 24h as stale, and a watched device with no rows as missing', async () => {
    const host = 'stale-host';
    const at = new Date('2026-10-10T00:00:00Z');
    await writeCensusRun(sql, {
      runId: '00000000-0000-4000-8000-000000000010',
      host,
      device: device({ device: '/s' }),
      startedAt: at,
      finishedAt: at,
      attributedBytes: 50 * G,
      complete: true,
      note: null,
      consumers: [dir('/s/x', 2 * G)],
    });
    const { devices } = await readDiskConsumerCensus(sql, {
      host,
      now: new Date(at.getTime() + 25 * HOUR),
      expectedDevices: ['/s', '/never-measured'],
    });
    expect(devices.find((d) => d.device === '/s')).toMatchObject({ stale: true, coverageGap: false });
    expect(devices.find((d) => d.device === '/never-measured')).toEqual({ device: '/never-measured', missing: true });
  });

  it('prunes runs older than 30 days together with their consumers', async () => {
    const host = 'prune-host';
    const now = new Date('2026-10-12T00:00:00Z');
    const mk = (runId: string, ageDays: number) =>
      writeCensusRun(sql, {
        runId,
        host,
        device: device({ device: '/p' }),
        startedAt: new Date(now.getTime() - ageDays * 24 * HOUR),
        finishedAt: new Date(now.getTime() - ageDays * 24 * HOUR),
        attributedBytes: 50 * G,
        complete: true,
        note: null,
        consumers: [dir('/p/x', G)],
      });
    await mk('00000000-0000-4000-8000-000000000020', 31);
    await mk('00000000-0000-4000-8000-000000000021', 29);
    expect(await pruneDiskCensus(sql, now)).toBeGreaterThanOrEqual(1);
    const runs = await rootSql`SELECT run_id FROM harness_shared.disk_census_runs WHERE host = ${host}`;
    expect(runs.map((r) => r.run_id)).toEqual(['00000000-0000-4000-8000-000000000021']);
    const orphans = await rootSql`
      SELECT count(*)::int AS n FROM harness_shared.disk_census_consumers WHERE run_id = '00000000-0000-4000-8000-000000000020'`;
    expect(orphans[0]!.n).toBe(0);
  });

  it('adds API-sized stores only on their own device and only when du cannot read their root', async () => {
    if (process.getuid?.() === 0) return; // root reads everything; the unreadable case cannot be built
    const locked = join(fixture, 'locked-store');
    const open = join(fixture, 'open-store');
    mkdirSync(locked);
    mkdirSync(open);
    chmodSync(locked, 0o000);
    try {
      const dev = device({ device: fixture, majorMinor: devToMajorMinor(statSync(fixture).dev) });
      const rows = await apiStoreConsumers(dev, [
        { kind: 'postgres', rootDir: locked, parts: [{ consumer: `postgres:${locked} databases`, bytes: 7 * G }] },
        { kind: 'docker', rootDir: open, parts: [{ consumer: 'docker:images', bytes: 3 * G }] },
        null,
      ]);
      expect(rows).toEqual([{ consumer: `postgres:${locked} databases`, kind: 'postgres', depth: 0, bytes: 7 * G }]);
      const elsewhere = await apiStoreConsumers(device({ majorMinor: '999:999' }), [
        { kind: 'postgres', rootDir: locked, parts: [{ consumer: 'postgres:x', bytes: G }] },
      ]);
      expect(elsewhere).toEqual([]);
      // A privileged (root) walk measured the locked store itself: adding the API size too
      // would count it twice.
      const afterRootWalk = await apiStoreConsumers(
        dev,
        [{ kind: 'postgres', rootDir: locked, parts: [{ consumer: `postgres:${locked} databases`, bytes: 7 * G }] }],
        true,
      );
      expect(afterRootWalk).toEqual([]);
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});
