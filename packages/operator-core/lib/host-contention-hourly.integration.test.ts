/**
 * Host contention history (papercusp-performance-audit-2026-10-12 P-002, D-005).
 *
 * Runs the REAL migrations 1234 (host_kernel_memory_samples) and 1485 (PSI stall
 * totals, per-cgroup CPU, host_contention_hourly view) against a fresh database and
 * proves two things a unit test cannot:
 *   1. the 60 s writer's INSERT lands every contention reading in the 1485 columns
 *      (a column-name or cast mistake in defaultStore fails here, not in production);
 *   2. the hourly view turns consecutive cumulative counters into the right stalled
 *      fractions and cores per cgroup, and skips what must not be differenced:
 *      gaps over 10 minutes, counter resets, reboots and pre-1485 rows;
 *   3. retention holds at the 60 s cadence: the kernel-leak check's real prune
 *      deletes rows older than KERNEL_LEAK_RETENTION_DAYS (spec PERF-P002-RETENTION).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
// eslint-disable-next-line import/no-relative-packages -- mirror the canonical org client's raw jsonb/Date serializers (see restoreRawJsonbSerializer's doc)
import { restoreRawDateSerializers, restoreRawJsonbSerializer } from '../../../libs/papercusp/libs/db/src/raw-serializers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../libs/papercusp/libs/db/sql');
const MIGRATIONS = ['1234-host-kernel-memory-samples.sql', '1485-host-contention-samples.sql'];

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('./agent-tools/coordination/escalations', () => ({ openEscalation: vi.fn() }));
vi.mock('./severe-event-broadcast', () => ({ broadcastSevereEvent: vi.fn(async () => true) }));
vi.mock('./alarm-attention', () => ({ resolveAlarm: vi.fn(async () => false) }));

const { runHostSampleOnce, runKernelLeakCheckOnce, KERNEL_LEAK_RETENTION_DAYS } = await import(
  './system-health/kernel-leak-watchdog'
);
type HostContentionReading = import('./system-health/kernel-leak-watchdog').HostContentionReading;
type KernelMemorySample = import('./system-health/kernel-leak-watchdog').KernelMemorySample;

const GIB = 1024 ** 3;
const BOOTED_AT = '2026-10-10T00:00:00.000Z';
const MINUTE = 60_000;

let db: FreshPgDb;

/**
 * The migration text minus GRANTs: a fresh test database need not have the
 * harness_app role, and the grants are not what this file tests.
 */
function migrationSql(file: string): string {
  return readFileSync(resolve(SQL_DIR, file), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*GRANT\b/i.test(l))
    .join('\n');
}

interface Counters {
  cpu: number;
  ioSome: number;
  ioFull: number;
  memSome: number;
  memFull: number;
  usage: Record<string, number> | null;
}

async function insertRow(host: string, bootId: string, atMs: number, c: Counters | null): Promise<void> {
  const at = new Date(atMs).toISOString();
  await db.sql`
    INSERT INTO harness_shared.host_kernel_memory_samples
      (boot_id, bucket_at, sampled_at, host, booted_at, mem_total_bytes, sunreclaim_bytes, slab_bytes, dying_descendants,
       cpu_some_stall_us, io_some_stall_us, io_full_stall_us, memory_some_stall_us, memory_full_stall_us,
       cgroup_cpu_usage_us)
    VALUES (${bootId}, ${at}, ${at}, ${host}, ${BOOTED_AT}, ${251 * GIB}, ${5 * GIB}, ${20 * GIB}, ${300},
            ${c?.cpu ?? null}, ${c?.ioSome ?? null}, ${c?.ioFull ?? null}, ${c?.memSome ?? null}, ${c?.memFull ?? null},
            ${c?.usage ? JSON.stringify(c.usage) : null}::jsonb)`;
}

interface HourlyRow {
  hour: Date;
  intervals: number;
  covered_s: string;
  cpu_some_frac: string | null;
  io_some_frac: string | null;
  io_full_frac: string | null;
  memory_some_frac: string | null;
  memory_full_frac: string | null;
  cgroup_cores: Record<string, number> | null;
}

async function hourly(host: string): Promise<HourlyRow[]> {
  return (await db.sql`
    SELECT * FROM harness_shared.host_contention_hourly WHERE host = ${host} ORDER BY hour`) as unknown as HourlyRow[];
}

/**
 * One counter set per minute that stalls CPU 10%, IO "some" 50% / "full" 20%,
 * memory "some" 1% / "full" 0%, with the host burning 40 cores and postgres 10.
 */
function steady(i: number): Counters {
  return {
    cpu: 21_700_182_638 + i * 6_000_000,
    ioSome: 987_654_321 + i * 30_000_000,
    ioFull: 555_555_555 + i * 12_000_000,
    memSome: 4_242 + i * 600_000,
    memFull: 1_717,
    usage: { '/': 5_000_000_000_000 + i * 2_400_000_000, 'system-postgresql.slice': 1_000_000_000_000 + i * 600_000_000 },
  };
}

beforeAll(async () => {
  db = await createFreshPgDb('host-contention');
  // Production's org client passes a pre-stringified `${JSON.stringify(v)}::jsonb`
  // through unchanged; a bare postgres() client JSON-encodes it a second time and
  // stores a jsonb STRING. Restore the production serializers so this test sees
  // exactly what the writer produces in production.
  restoreRawJsonbSerializer(db.sql);
  restoreRawDateSerializers(db.sql);
  h.sql = db.sql;
  for (const file of MIGRATIONS) await db.sql.unsafe(migrationSql(file));
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('host contention samples (migration 1485)', () => {
  const contention: HostContentionReading = {
    pressure: { cpuSomeUs: 11, ioSomeUs: 22, ioFullUs: 33, memorySomeUs: 44, memoryFullUs: null },
    cgroupCpuUsageUs: { '/': 9_000_000_000_000, 'papercusp-dev-api.service': 123_456 },
  };
  const sampleAt = (iso: string): KernelMemorySample => ({
    bootId: 'boot-writer',
    host: 'writer-host',
    sampledAtMs: Date.parse(iso),
    bootedAtMs: Date.parse(BOOTED_AT),
    memTotalBytes: 251 * GIB,
    sUnreclaimBytes: 5 * GIB,
    slabBytes: 20 * GIB,
    dyingDescendants: 278,
  });

  it('the 60 s writer stores PSI totals and per-cgroup CPU in the new columns, one row per 60 s bucket', async () => {
    const first = await runHostSampleOnce({
      readSample: async () => sampleAt('2026-10-12T08:00:30Z'),
      readContention: async () => contention,
    });
    expect(first.stored).toBe(true);
    // Same 60 s bucket: ON CONFLICT DO NOTHING keeps the first reading.
    await runHostSampleOnce({
      readSample: async () => sampleAt('2026-10-12T08:00:45Z'),
      readContention: async () => ({ pressure: null, cgroupCpuUsageUs: { '/': 1 } }),
    });
    // Next bucket, contention unreadable: the sample still lands, contention columns NULL.
    await runHostSampleOnce({
      readSample: async () => sampleAt('2026-10-12T08:01:10Z'),
      readContention: async () => null,
    });

    const rows = await db.sql`
      SELECT bucket_at, cpu_some_stall_us, io_some_stall_us, io_full_stall_us, memory_some_stall_us,
             memory_full_stall_us, cgroup_cpu_usage_us, dying_descendants
        FROM harness_shared.host_kernel_memory_samples
       WHERE boot_id = 'boot-writer' ORDER BY bucket_at`;
    expect(rows.map((r) => (r.bucket_at as Date).toISOString())).toEqual([
      '2026-10-12T08:00:00.000Z',
      '2026-10-12T08:01:00.000Z',
    ]);
    expect(rows[0]).toMatchObject({
      cpu_some_stall_us: 11,
      io_some_stall_us: 22,
      io_full_stall_us: 33,
      memory_some_stall_us: 44,
      memory_full_stall_us: null,
      cgroup_cpu_usage_us: { '/': 9_000_000_000_000, 'papercusp-dev-api.service': 123_456 },
      dying_descendants: 278,
    });
    expect(rows[1]).toMatchObject({
      cpu_some_stall_us: null,
      io_some_stall_us: null,
      io_full_stall_us: null,
      memory_some_stall_us: null,
      memory_full_stall_us: null,
      cgroup_cpu_usage_us: null,
    });
  });

  it('host_contention_hourly reports stalled fractions and cores per cgroup from consecutive 60 s rows', async () => {
    const t0 = Date.parse('2026-10-12T10:00:00Z');
    // Two pre-1485 rows (10-minute cadence, no contention columns) must contribute nothing.
    await insertRow('tower', 'boot-a', t0 - 20 * MINUTE, null);
    await insertRow('tower', 'boot-a', t0 - 10 * MINUTE, null);
    for (let i = 0; i <= 5; i++) await insertRow('tower', 'boot-a', t0 + i * MINUTE, steady(i));

    const rows = await hourly('tower');
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.hour.toISOString()).toBe('2026-10-12T10:00:00.000Z');
    expect(Number(r.intervals)).toBe(5);
    expect(Number(r.covered_s)).toBe(300);
    expect(Number(r.cpu_some_frac)).toBeCloseTo(0.1, 9);
    expect(Number(r.io_some_frac)).toBeCloseTo(0.5, 9);
    expect(Number(r.io_full_frac)).toBeCloseTo(0.2, 9);
    expect(Number(r.memory_some_frac)).toBeCloseTo(0.01, 9);
    expect(Number(r.memory_full_frac)).toBe(0);
    expect(r.cgroup_cores).toEqual({ '/': 40, 'system-postgresql.slice': 10 });
  });

  it('skips gaps over 10 minutes, counter resets and reboots; a 10-minute interval still counts', async () => {
    const t = (hhmm: string): number => Date.parse(`2026-10-12T${hhmm}:00Z`);
    const reset = (c: Counters): Counters => ({ ...c, usage: { ...c.usage!, 'system-postgresql.slice': 5 } });
    await insertRow('tower-2', 'boot-c', t('10:40'), steady(0));
    await insertRow('tower-2', 'boot-c', t('11:00'), steady(1)); // 20 min gap: not differenced
    await insertRow('tower-2', 'boot-c', t('11:01'), reset(steady(2))); // postgres restarted: its delta is skipped
    await insertRow('tower-2', 'boot-d', t('11:02'), { ...steady(0), cpu: 1, usage: { '/': 1 } }); // reboot: new partition
    await insertRow('tower-2', 'boot-c', t('12:00'), steady(3)); // 59 min gap: not differenced
    await insertRow('tower-2', 'boot-c', t('12:10'), { ...steady(3), cpu: steady(3).cpu + 60_000_000 }); // exactly 600 s

    const rows = await hourly('tower-2');
    expect(rows.map((r) => r.hour.toISOString())).toEqual(['2026-10-12T11:00:00.000Z', '2026-10-12T12:00:00.000Z']);
    const [h11, h12] = rows as [HourlyRow, HourlyRow];
    expect(Number(h11.intervals)).toBe(1);
    expect(Number(h11.covered_s)).toBe(60);
    expect(Number(h11.cpu_some_frac)).toBeCloseTo(0.1, 9);
    expect(h11.cgroup_cores).toEqual({ '/': 40 });
    expect(Number(h12.intervals)).toBe(1);
    expect(Number(h12.covered_s)).toBe(600);
    expect(Number(h12.cpu_some_frac)).toBeCloseTo(0.1, 9);
    expect(h12.cgroup_cores).toEqual({ '/': 0, 'system-postgresql.slice': 0 });
  });

  it('the kernel-leak check prunes rows older than the retention window and keeps the rest', async () => {
    const now = Date.now();
    const DAY = 24 * 60 * MINUTE;
    const expired = now - (KERNEL_LEAK_RETENTION_DAYS + 1) * DAY;
    const kept = now - (KERNEL_LEAK_RETENTION_DAYS - 1) * DAY;
    await insertRow('retention-host', 'boot-r', expired, steady(0));
    await insertRow('retention-host', 'boot-r', kept, steady(1));

    const r = await runKernelLeakCheckOnce({
      readSample: async () => ({ ...sampleAt(new Date(now).toISOString()), bootId: 'boot-r', host: 'retention-host' }),
      readContention: async () => contention,
      escalate: async () => {},
    });
    expect(r.skipped).toBe(false);

    const rows = await db.sql`
      SELECT sampled_at FROM harness_shared.host_kernel_memory_samples WHERE boot_id = 'boot-r' ORDER BY sampled_at`;
    const ages = rows.map((row) => Math.round((now - (row.sampled_at as Date).getTime()) / DAY));
    expect(ages).toEqual([KERNEL_LEAK_RETENTION_DAYS - 1, 0]);
  });
});
