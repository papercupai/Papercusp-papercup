/**
 * Real-PostgreSQL + real-du coverage for the disk consumer census
 * (disk-headroom-standing-reclaim-2026-10-12 P-001, R-1; WI-6554700010008933).
 *
 * R-1: a per-consumer size census is written to Postgres and one read shows each
 * consumer's size and its 24h growth. Falsifiers covered here: a device with no
 * census rows in 24h is reported (stale / missing), and a consumer at or above the
 * floor that the census does not list fails the du comparison below.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import {
  apiStoreConsumers,
  diskCensusPassInFlight,
  pruneDiskCensus,
  readDiskConsumerCensus,
  runDiskConsumerCensusOnce,
  unattributedKey,
  writeCensusRun,
  type CensusDevice,
  type CensusSql,
} from './disk-consumer-census';
import { devToMajorMinor, type CensusConsumer } from './usage';
import { detectDiskGrowthWarnings, runDiskHeadroomAlarmOnce, emitStorageGrowthToast,
  DISK_HEADROOM_OBSERVATION_ACTION, measureNativeDiskHeadroomAlarm, type DiskHeadroomObservation } from './storage-growth-alarm';

// Toast/audit persistence uses the real throwaway PG below. The host SSE sink
// resolves its own live org pool, so keep that separate outbound boundary local.
const invalidation = vi.hoisted(() => ({ notify: vi.fn(async () => {}) }));
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: invalidation.notify }));

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = resolve(HERE, '../../../../libs/papercusp/libs/db/sql/1472-disk-consumer-census.sql');
const MIGRATION = readFileSync(existsSync(MIGRATION_PATH) ? MIGRATION_PATH : `${MIGRATION_PATH}.DRAFT`, 'utf8');

const MIB = 1024 ** 2;
const G = 1024 ** 3;
const HOUR = 3600_000;

let rootSql: postgres.Sql;
let notificationSql: postgres.Sql;
let sql: CensusSql;
let fixture: string;

beforeEach(() => { invalidation.notify.mockClear(); });

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
  // Drizzle replaces its client's timestamp/JSON codecs. Never give it the
  // native census client, whose Date parameters need postgres.js serialization.
  notificationSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await rootSql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  await rootSql.unsafe(MIGRATION);
  await rootSql.unsafe(`CREATE TABLE harness_shared.toast_log (
    id bigserial PRIMARY KEY, level text NOT NULL, message text NOT NULL CHECK (message <> 'refuse-notification'),
    description text, harness_slug text, created_at bigint NOT NULL, action_label text, action_href text);
    CREATE TABLE harness_shared.audit_log (id text PRIMARY KEY, ts bigint NOT NULL, actor text NOT NULL,
    action text NOT NULL, subject text NOT NULL, details jsonb, workspace_id text NOT NULL)`);
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
  await notificationSql?.end({ timeout: 5 });
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
    expect(view.baselineStatus).toBe('unavailable');
    expect(view.coverageIssues).toEqual([]);
    expect(view.baselineAvailBytes).toBeNull();
    expect(view.consumers!.every((c) => c.growth24hBytes === null)).toBe(true);
  }, 120_000);

  it('reports each consumer’s 24h growth against the run nearest 24h earlier, and ignores runs outside 18–30h', async () => {
    const host = 'growth-host';
    const dev = device({ device: '/g' });
    const latestAt = new Date('2026-10-12T12:00:00Z');
    const write = (runId: string, at: Date, consumers: CensusConsumer[], complete = true, availBytes = 50 * G) =>
      writeCensusRun(sql, { runId, host, device: { ...dev, availBytes, usedBytes: dev.sizeBytes - availBytes }, startedAt: at, finishedAt: at, attributedBytes: 40 * G, complete, note: null, consumers });
    await write('00000000-0000-4000-8000-000000000001', new Date(latestAt.getTime() - 40 * HOUR), [dir('/g/a', 1 * G)]);
    await write('00000000-0000-4000-8000-000000000002', new Date(latestAt.getTime() - 23 * HOUR), [dir('/g/a', 10 * G), dir('/g/b', 8 * G)], true, 80 * G);
    // Closer to 24h but incomplete: never a baseline.
    await write('00000000-0000-4000-8000-000000000003', new Date(latestAt.getTime() - 24 * HOUR), [dir('/g/a', 2 * G)], false, 90 * G);
    await write('00000000-0000-4000-8000-000000000004', latestAt, [dir('/g/a', 25 * G), dir('/g/b', 6 * G), dir('/g/new', 3 * G)]);

    const { devices } = await readDiskConsumerCensus(sql, { host, orderBy: 'growth', now: latestAt });
    const view = devices[0]!;
    expect(view).toMatchObject({ host, runId: '00000000-0000-4000-8000-000000000004',
      baselineRunId: '00000000-0000-4000-8000-000000000002' });
    expect(view.baselineAt).toBe(new Date(latestAt.getTime() - 23 * HOUR).toISOString());
    expect(view.availBytes).toBe(50 * G);
    expect(view.baselineAvailBytes).toBe(80 * G);
    expect(view.baselineSizeBytes).toBe(100 * G);
    expect(view.consumers!.map((c) => [c.consumer, c.bytes, c.growth24hBytes])).toEqual([
      ['/g/a', 25 * G, 15 * G],
      ['/g/b', 6 * G, -2 * G],
      ['/g/new', 3 * G, null],
    ]);
    expect(view.stale).toBe(false);
    expect(view.coverageGap).toBe(true); // used 50 GiB − attributed 40 GiB = 10 GiB unattributed
    // The forecast uses the selected clean baseline's filesystem delta and actual
    // 23h interval, not the latest free space or the overlapping consumer totals.
    const warnings = detectDiskGrowthWarnings(devices);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.growthBytesPerDay).toBeCloseTo(30 * G * 24 / 23);
    expect(warnings[0]!.daysToFull).toBeCloseTo(50 / (30 * 24 / 23));
    expect(warnings[0]!.topGrowers).toEqual([{ consumer: '/g/a', growthBytes: 15 * G }]);
    const notifications: string[] = [];
    const alarm = await runDiskHeadroomAlarmOnce({
      readDiskCensus: async () => (await readDiskConsumerCensus(sql, { host, orderBy: 'growth', now: latestAt })).devices,
      emitToast: async toast => { notifications.push(toast.description); },
    });
    expect(alarm.diskGrowth).toEqual(warnings);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain('full in 1.6d');
    expect(notifications[0]).toContain('/g/a');

    const options = { db: drizzle(notificationSql) as never, workspaceId: 'headroom-native-fixture' };
    await runDiskHeadroomAlarmOnce({ readDiskCensus: async () => devices,
      emitToast: (toast, observation) => emitStorageGrowthToast(toast, observation, options) });
    const saved = await rootSql`SELECT a.subject, a.details, t.id, t.message, t.description
      FROM harness_shared.audit_log a JOIN harness_shared.toast_log t ON t.id::text=a.subject
      WHERE a.action=${DISK_HEADROOM_OBSERVATION_ACTION} AND a.workspace_id=${options.workspaceId}`;
    expect(saved).toHaveLength(1);
    const receipt = saved[0]!.details as DiskHeadroomObservation & { notification: { id: string; message: string; description: string } };
    expect(receipt.devices[0]).toMatchObject({ host, runId: view.runId, baselineRunId: view.baselineRunId });
    expect(receipt.growth).toEqual(warnings);
    expect(receipt.notification).toMatchObject({ id: String(saved[0]!.id), message: saved[0]!.message,
      description: saved[0]!.description });
    expect(invalidation.notify).toHaveBeenCalledWith('toastLog.recent', undefined);
    expect(invalidation.notify).toHaveBeenCalledTimes(1);
    const toast = { level: 'warning', message: 'refuse-notification', description: 'must not leave evidence' };
    await expect(emitStorageGrowthToast(toast, receipt, options)).rejects.toThrow();
    expect(invalidation.notify).toHaveBeenCalledTimes(1);
    expect((await rootSql`SELECT count(*)::int n FROM harness_shared.audit_log`)[0]!.n).toBe(1);
    // Evidence failure must roll back the notification too, keeping their linkage atomic.
    await rootSql.unsafe('ALTER TABLE harness_shared.audit_log ADD CONSTRAINT refuse_evidence CHECK (false) NOT VALID');
    try {
      await expect(emitStorageGrowthToast({ ...toast, message: 'evidence-refused' }, receipt, options)).rejects.toThrow();
      expect((await rootSql`SELECT count(*)::int n FROM harness_shared.toast_log`)[0]!.n).toBe(1);
    } finally { await rootSql.unsafe('ALTER TABLE harness_shared.audit_log DROP CONSTRAINT refuse_evidence'); }

    // Only a 40h-old run besides the latest: outside the window, so no baseline.
    const only = await readDiskConsumerCensus(sql, { host, now: latestAt, device: '/g' });
    expect(only.devices).toHaveLength(1);
    expect(only.devices[0]!.baselineRunId).toBe(view.baselineRunId);
  });

  it('verifies native alarm decisions against all four hourly census histories and their actual notification', async () => {
    const host = 'native-headroom-verifier', workspaceId = 'native-headroom-verifier';
    const devices = ['/', '/mnt/data', '/mnt/cold-a', '/mnt/cold-b'];
    const epoch = Date.now();
    for (const path of devices) {
      for (let h = 0; h <= 24; h++) {
        const at = new Date(h === 24 ? epoch - 60_000 : epoch - 24 * HOUR + (h + 0.5) * HOUR);
        const availBytes = h === 24 ? 200e9 : 300e9;
        await writeCensusRun(sql, { runId: randomUUID(), host,
          device: device({ device: path, sizeBytes: 2e12, availBytes, usedBytes: 2e12 - availBytes }),
          startedAt: at, finishedAt: at, attributedBytes: 2e12 - availBytes, complete: true, note: null,
          producerBuildSha: 'native-verifier-fixture',
          consumers: [dir(`${path}/grower`, h === 24 ? 200e9 : 100e9)] });
      }
    }
    const native = await readDiskConsumerCensus(sql, { host, orderBy: 'growth', limit: 20, expectedDevices: devices });
    await runDiskHeadroomAlarmOnce({ readDiskCensus: async () => native.devices,
      emitToast: (toast, observation) => emitStorageGrowthToast(toast, { ...observation!,
        runtime: { ...observation!.runtime, host, buildSha: 'native-verifier-fixture' } },
      { db: drizzle(notificationSql) as never, workspaceId }) });
    const scope = { workspaceId, host, buildSha: 'native-verifier-fixture' };
    expect((await measureNativeDiskHeadroomAlarm(rootSql, scope)).verdict).toBe('pass');
    expect((await measureNativeDiskHeadroomAlarm(rootSql, { ...scope, buildSha: 'other' })).verdict).toBe('unknown');
    const snapshotEnd = new Date(Date.now() + 1_000).toISOString();
    const snapshot = { ...scope, windowStart: new Date(epoch - 90 * 60_000).toISOString(), windowEnd: snapshotEnd };
    // New ordinary census runs and a fifth device cannot rewrite the alarm's inputs.
    for (const path of [...devices, '/mnt/unrelated']) {
      const at = new Date(epoch + 30 * 60_000);
      await writeCensusRun(sql, { runId: randomUUID(), host,
        device: device({ device: path }), startedAt: at, finishedAt: at,
        attributedBytes: 0, complete: false, note: null, consumers: [] });
    }
    expect((await measureNativeDiskHeadroomAlarm(rootSql, { ...scope, now: epoch + 31 * 60_000 })).verdict).toBe('pass');
    expect((await measureNativeDiskHeadroomAlarm(rootSql, { ...snapshot, now: epoch + 7 * 86400_000 })).verdict).toBe('pass');
    expect((await measureNativeDiskHeadroomAlarm(rootSql, { ...scope, now: epoch + 91 * 60_000 })).verdict).toBe('unknown');
    // The alarm's current build must not relabel historical census producers.
    await rootSql`UPDATE harness_shared.disk_census_runs SET note='census-producer:older; '
      WHERE host=${host} AND device='/' AND started_at BETWEEN ${new Date(epoch - 12 * HOUR)} AND ${new Date(epoch - 11 * HOUR)}`;
    expect((await measureNativeDiskHeadroomAlarm(rootSql, snapshot)).verdict).toBe('unknown');
    await rootSql`UPDATE harness_shared.disk_census_runs SET note='census-producer:native-verifier-fixture; ' WHERE host=${host}`;
    // A missing middle hour must fail even with valid latest+baseline endpoints.
    await rootSql`UPDATE harness_shared.disk_census_runs SET complete=false WHERE host=${host}
      AND device='/' AND started_at BETWEEN ${new Date(epoch - 12 * HOUR)} AND ${new Date(epoch - 11 * HOUR)}`;
    expect((await measureNativeDiskHeadroomAlarm(rootSql, scope)).verdict).toBe('unknown');
    await rootSql`UPDATE harness_shared.disk_census_runs SET complete=true WHERE host=${host} AND finished_at<=${new Date(epoch)}`;
    // A tampered decision is distinguished from a missing/detached notification.
    await rootSql`UPDATE harness_shared.audit_log SET details=jsonb_set(details,'{horizonDays}','8') WHERE workspace_id=${workspaceId}`;
    expect((await measureNativeDiskHeadroomAlarm(rootSql, scope)).verdict).toBe('fail');
    await rootSql`UPDATE harness_shared.audit_log SET details=jsonb_set(details,'{horizonDays}','7') WHERE workspace_id=${workspaceId}`;
    await rootSql`DELETE FROM harness_shared.toast_log WHERE id::text IN
      (SELECT subject FROM harness_shared.audit_log WHERE workspace_id=${workspaceId})`;
    expect((await measureNativeDiskHeadroomAlarm(rootSql, scope)).verdict).toBe('unknown');
  });

  it('admits the oldest census pass and sheds overlapping hourly starts without wedging on stale or terminal rows', async () => {
    await rootSql.unsafe('CREATE SCHEMA IF NOT EXISTS dbos');
    // Only the SDK-owned columns read by the guard are needed in this private database.
    await rootSql.unsafe('CREATE TABLE dbos.workflow_status (workflow_uuid text PRIMARY KEY, name text, status text, created_at bigint, started_at_epoch_ms bigint)');
    const now = Date.now();
    const add = (id: string, name: string, status: string, createdAt: number) => rootSql`
      INSERT INTO dbos.workflow_status VALUES (${id}, ${name}, ${status}, ${createdAt}, ${status === 'ENQUEUED' ? null : createdAt})`;
    await add('old', 'diskConsumerCensus', 'PENDING', now - 75 * HOUR / 60);
    await add('self', 'diskConsumerCensus', 'PENDING', now);
    expect(await diskCensusPassInFlight(sql, 'self', 2, now)).toBe(true);
    expect(await diskCensusPassInFlight(sql, 'old', 2, now)).toBe(false);
    await rootSql`UPDATE dbos.workflow_status SET status = 'ENQUEUED', started_at_epoch_ms = NULL WHERE workflow_uuid = 'old'`;
    expect(await diskCensusPassInFlight(sql, 'self', 2, now)).toBe(true);
    await rootSql`UPDATE dbos.workflow_status SET status = 'SUCCESS' WHERE workflow_uuid = 'old'`;
    await add('unrelated', 'anotherWorkflow', 'PENDING', now - HOUR);
    await add('stale', 'diskConsumerCensus', 'PENDING', now - 4 * HOUR);
    expect(await diskCensusPassInFlight(sql, 'self', 2, now)).toBe(false);
    await rootSql.unsafe('DROP TABLE dbos.workflow_status');
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
    expect(unknown.baselineRunId).toBeNull();
    expect(unknown.baselineStatus).toBe('visibility-mismatch');
    expect(unknown.baselineAt).toBeNull(); expect(unknown.consumers![0]!.growth24hBytes).toBeNull();
    expect(unknown.baselineAvailBytes).toBeNull();
    await write('00000000-0000-4000-8000-000000000084', 22, 'du walked as root (sudo -n)', 38 * G);
    const calibrated = (await readDiskConsumerCensus(sql, { host, now: at })).devices[0]!;
    expect(calibrated.baselineAt).toBe(new Date(at.getTime() - 22 * HOUR).toISOString());
    expect(calibrated.baselineRunId).toBe('00000000-0000-4000-8000-000000000084');
    expect(calibrated.baselineStatus).toBe('comparable');
    expect(calibrated.consumers![0]!.growth24hBytes).toBe(2 * G);
  });

  it('reports historical denied scans as incomplete even when the old writer stored complete=true', async () => {
    const at = new Date('2026-10-13T17:00:00Z');
    await writeCensusRun(sql, { runId: '00000000-0000-4000-8000-000000000085', host: 'legacy-denied-host', device: device({ device: '/denied' }), startedAt: at, finishedAt: at, attributedBytes: G, complete: true, note: '3 unreadable path(s), e.g. /db', consumers: [dir('/denied/data', G)] });
    const view = (await readDiskConsumerCensus(sql, { host: 'legacy-denied-host', now: at })).devices[0]!;
    expect(view.complete).toBe(false); expect(view.baselineAt).toBeNull();
    expect(view.coverageIssues).toContain('unreadable-paths');
    expect(view.baselineStatus).toBe('latest-incomplete');
  });

  it('reports recorded scan failures without guessing why an unexplained run is incomplete', async () => {
    const at = new Date('2026-10-13T17:00:00Z');
    for (const [host, complete, note, issues] of [
      ['recorded-coverage-host', true, 'du timed out; du failed: exit 1; du returned no root record; 3 unreadable path(s); own files of /db may be incomplete (find failed)',
        ['walk-timeout', 'walk-error', 'root-record-missing', 'unreadable-paths', 'own-files-incomplete']],
      ['unexplained-coverage-host', false, 'du walked unprivileged (sudo -n unavailable)', ['incomplete-run']],
    ] as const) {
      await writeCensusRun(sql, { runId: randomUUID(), host, device: device(), startedAt: at, finishedAt: at,
        attributedBytes: 50 * G, complete, note, consumers: [dir('/data', 50 * G)] });
      const view = (await readDiskConsumerCensus(sql, { host, now: at })).devices[0]!;
      expect(view).toMatchObject({ complete: false, coverageGap: false, coverageIssues: issues,
        baselineStatus: 'latest-incomplete', baselineRunId: null, baselineAt: null });
      expect(view.consumers![0]!.growth24hBytes).toBeNull();
    }
  });

  it('persists a missing root record as an explicit producer coverage failure', async () => {
    const at = new Date('2026-10-13T17:00:00Z'); const host = 'missing-root-record-host';
    const result = await runDiskConsumerCensusOnce({ sql, host, devices: [device()], now: () => at,
      statDevice: null, resolveSudo: async () => null,
      measurePostgres: async () => null, measureDocker: async () => null,
      runDu: async () => ({ summary: { rootBytes: null, consumers: [dir('/test-dev/data', 2 * G)], ownFiles: [], records: 1 },
        deniedCount: 0, deniedSample: [], timedOut: false, exitCode: 0 }),
    });
    expect(result.failures).toEqual([]);
    expect(result.runs[0]!.complete).toBe(false);
    const view = (await readDiskConsumerCensus(sql, { host, now: at })).devices[0]!;
    expect(view.note).toContain('du returned no root record; sizes are lower bounds');
    expect(view).toMatchObject({ complete: false, coverageIssues: ['root-record-missing', 'unattributed-bytes'],
      baselineStatus: 'latest-incomplete', baselineAt: null });
    expect(view.consumers!.find(c => c.consumer === '/test-dev/data')!.growth24hBytes).toBeNull();
  });

  it.each([
    { label: '0', exitCode: 0, expectedComplete: true, note: null, stderrSample: [] },
    { label: '1', exitCode: 1, expectedComplete: false, note: 'du exited with status 1; sizes are lower bounds',
      stderrSample: ['du: cannot access path-gone: No such file or directory'] },
    { label: 'null', exitCode: null, expectedComplete: false,
      note: 'du exited without an exit status; sizes are lower bounds', stderrSample: [] },
  ] as const)('persists completeness for du exitCode $label', async ({ label, exitCode, expectedComplete, note, stderrSample }) => {
    const at = new Date('2026-10-13T18:00:00Z'); const host = `du-exit-status-${label}-host`;
    const result = await runDiskConsumerCensusOnce({ sql, host, devices: [device()], now: () => at,
      statDevice: null, resolveSudo: async () => null,
      measurePostgres: async () => null, measureDocker: async () => null,
      runDu: async () => ({ summary: { rootBytes: 50 * G, consumers: [dir('/test-dev/data', 50 * G)], ownFiles: [], records: 2 },
        deniedCount: 0, deniedSample: [], timedOut: false, exitCode,
        ...(stderrSample.length ? { stderrSample: [...stderrSample] } : {}) }),
    });
    expect(result.failures).toEqual([]);
    expect(result.runs[0]!.complete).toBe(expectedComplete);
    const persisted = (await readDiskConsumerCensus(sql, { host, now: at })).devices[0]!;
    expect(persisted.complete).toBe(expectedComplete);
    if (note) expect(persisted.note).toContain(note);
    if (stderrSample.length) expect(persisted.note).toContain('du stderr: ' + stderrSample.join(' | '));
  });

  it('distinguishes unreadable baseline candidates from an absent qualified baseline', async () => {
    const at = new Date('2026-10-13T17:00:00Z'); const host = 'unreadable-baseline-host';
    await writeCensusRun(sql, { runId: randomUUID(), host, device: device(), startedAt: new Date(at.getTime() - 24 * HOUR),
      finishedAt: new Date(at.getTime() - 24 * HOUR), attributedBytes: 50 * G, complete: true,
      note: 'du walked as root (sudo -n); 3 unreadable path(s)', consumers: [dir('/data', 50 * G)] });
    await writeCensusRun(sql, { runId: randomUUID(), host, device: device(), startedAt: at, finishedAt: at,
      attributedBytes: 50 * G, complete: true, note: 'du walked as root (sudo -n)', consumers: [dir('/data', 50 * G)] });
    const view = (await readDiskConsumerCensus(sql, { host, now: at })).devices[0]!;
    expect(view).toMatchObject({ complete: true, coverageIssues: [], baselineStatus: 'incomplete-candidates', baselineAt: null });
    expect(view.consumers![0]!.growth24hBytes).toBeNull();
  });

  it('keeps a byte-attribution gap distinct from an incomplete scan', async () => {
    const at = new Date('2026-10-13T17:00:00Z'); const host = 'attribution-gap-host';
    await writeCensusRun(sql, { runId: randomUUID(), host, device: device(), startedAt: at, finishedAt: at,
      attributedBytes: 30 * G, complete: true, note: null, consumers: [dir('/data', 30 * G)] });
    const view = (await readDiskConsumerCensus(sql, { host, now: at })).devices[0]!;
    expect(view).toMatchObject({ complete: true, coverageGap: true, coverageIssues: ['unattributed-bytes'],
      baselineStatus: 'unavailable', baselineAt: null });
    expect(view.consumers![0]!.growth24hBytes).toBeNull();
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
