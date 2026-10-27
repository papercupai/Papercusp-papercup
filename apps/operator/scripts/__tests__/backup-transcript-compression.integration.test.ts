import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import postgres from 'postgres';
import { expect, it } from 'vitest';
import { resolveNativePgBinDir, startDedicatedNativePg } from '@papercusp/test-config/pg';

const exec = promisify(execFile);
const producerPath = resolve(import.meta.dirname, '../systemd/papercusp-db-backup.sh');
const seed = 'papercusp-backup-transcript-p002-v1';
const rowCount = 192;
const bytesPerRow = 64 * 1024;

// SHA256(UTF8(seed) || uint32be(block counter)), concatenated without resetting
// the counter between rows: exactly 12 MiB of reproducible high-entropy BYTEA.
function payloadForRow(row: number): Buffer {
  const bytes = Buffer.alloc(bytesPerRow);
  const counter = Buffer.alloc(4);
  for (let offset = 0; offset < bytes.length; offset += 32) {
    counter.writeUInt32BE(row * (bytesPerRow / 32) + offset / 32);
    createHash('sha256').update(seed).update(counter).digest().copy(bytes, offset);
  }
  return bytes;
}

function functionFrom(source: string, name: string): string {
  const start = source.indexOf(`\n${name}() {\n`);
  const end = source.indexOf('\n}\n', start);
  expect(start, `producer function ${name}`).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start + 1, end + 3);
}

async function archiveFiles(root: string, prefix = ''): Promise<{ name: string; bytes: number }[]> {
  const files: { name: string; bytes: number }[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const name = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await archiveFiles(root, name));
    else {
      // Never follow symlinks or silently count external logs/allocation blocks.
      expect(entry.isFile(), `archive member ${name} must be a regular file`).toBe(true);
      files.push({ name, bytes: (await stat(join(root, name))).size });
    }
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

async function values(sql: postgres.Sql) {
  return Array.from(await sql`
    SELECT id, encode(sha256(payload), 'hex') AS payload_sha256,
           encode(sha256(convert_to(body, 'UTF8')), 'hex') AS body_sha256
      FROM public.backup_transcript_fixture ORDER BY id`);
}

it('restores native PG18 transcript values and reduces paired snapshot archive bytes to at most 65%', async (context) => {
  const work = await mkdtemp(join(tmpdir(), 'backup-transcript-p002-'));
  const bin = resolveNativePgBinDir();
  const source = await readFile(producerPath, 'utf8');
  const transcriptCall = source.split('\n').find(line =>
    line.trim().startsWith('if guarded_dump_one "$db" "$db-transcript"'));
  expect(transcriptCall, 'exercise the current transcript producer call site').toBeDefined();
  const pg = await startDedicatedNativePg({ baseDir: work });
  const sql = postgres(pg.getConnectionUri(), { max: 2, onnotice: () => {} });
  const restored: postgres.Sql[] = [];
  try {
    const [[server], dumpVersion, restoreVersion] = await Promise.all([
      sql`SELECT current_setting('server_version_num')::int AS version`,
      exec(join(bin, 'pg_dump'), ['--version']),
      exec(join(bin, 'pg_restore'), ['--version']),
    ]);
    expect(Math.floor(server.version / 10000)).toBe(18);
    expect(dumpVersion.stdout).toMatch(/\(PostgreSQL\) 18\./);
    expect(restoreVersion.stdout).toMatch(/\(PostgreSQL\) 18\./);
    await sql`CREATE TABLE public.backup_transcript_fixture (
      id integer PRIMARY KEY, payload bytea NOT NULL, body text)`;
    const expected = [];
    for (let row = 0; row < rowCount; row++) {
      const payload = payloadForRow(row);
      const body = row % 7 === 0 ? null : row % 7 === 1 ? '' :
        `row=${row}\nUnicode: café / 日本語 / 🦉\t${'deterministic transcript text; '.repeat(80)}`;
      await sql`INSERT INTO public.backup_transcript_fixture VALUES (${row}, ${payload}, ${body})`;
      expected.push({ id: row,
        payload_sha256: createHash('sha256').update(payload).digest('hex'),
        body_sha256: body === null ? null : createHash('sha256').update(body).digest('hex') });
    }
    const [population] = await sql`SELECT count(*)::int AS rows,
      sum(octet_length(payload))::int AS bytes FROM public.backup_transcript_fixture`;
    expect(population).toEqual({ rows: rowCount, bytes: 12 * 1024 * 1024 });
    const snapshot = await sql.reserve();
    let sourceDigest = '';
    try {
      await snapshot.unsafe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const [{ id: snapshotId }] = await snapshot`SELECT pg_export_snapshot() AS id`;
      const originalValues = await values(snapshot);
      expect(originalValues).toEqual(expected);
      sourceDigest = createHash('sha256').update(JSON.stringify(originalValues)).digest('hex');

      // Real writes on either side of the first dump distinguish snapshot reuse
      // from two merely sequential dumps of a quiescent database.
      await sql`UPDATE public.backup_transcript_fixture SET body = 'after export' WHERE id = 0`;
      const harness = [
        'set -euo pipefail',
        'PGOUT="$FIXTURE_ROOT"; JOBS=4; TIMEOUT_SEC=60; TIMEOUT_MAX_SEC=120',
        'db=postgres; BACKUP_USER=fixture; BACKUP_MIGRATION_ADVISORY_DATABASE=not-this-fixture',
        'PC_BACKUP_SPACE_SAFETY=140; PC_BACKUP_MIN_FREE_GB=0; HOST_BACKUP_APPLICATION_NAME=pcbackup',
        "DISPOSABLE_SCHEMA_PATTERN='bench_memory*'",
        'inc=(--table=public.backup_transcript_fixture "--snapshot=$FIXTURE_SNAPSHOT")',
        // The native fixture owns its whole cluster. Adapt OS identity and the
        // production socket to that cluster; keep dump arguments and promotion.
        'sudo() {',
        '  [ "$1" != -n ] || shift',
        '  if [ "$1" = -u ]; then shift 2; fi',
        '  if [ "$1" = env ]; then shift; export "$1"; shift; fi',
        '  if [ "$1" = chown ]; then return 0; fi',
        '  "$@"',
        '}',
        'pg_dump() {',
        '  [ "$1" = -h ] && [ "$2" = /var/run/postgresql ] || return 91',
        '  shift 2',
        '  "$NATIVE_PG_BIN/pg_dump" -h 127.0.0.1 -p "$FIXTURE_PORT" -U postgres "$@"',
        '}',
        'pg_restore() { "$NATIVE_PG_BIN/pg_restore" "$@"; }',
        // Watchdog boundaries and legal-hold policy have separate retained P001
        // proof; this rung measures native encoding and selected-table restore.
        'run_bounded_watched() { shift 3; "$@"; }',
        'fs_avail_gb() { echo 1000; }',
        'log() { printf "%s\\n" "$*"; }',
        functionFrom(source, 'rm_tmp'), functionFrom(source, 'dump_one'),
        'guarded_dump_one() { dump_one "$@"; }',
      ].join('\n');
      const env = { ...process.env, FIXTURE_ROOT: work, FIXTURE_PORT: String(pg.port),
        NATIVE_PG_BIN: bin, FIXTURE_SNAPSHOT: String(snapshotId) };
      await exec('bash', ['-c', `${harness}\ndump_one "$db" "$db-baseline" "\${inc[@]}"`],
        { env, timeout: 120_000, maxBuffer: 1024 * 1024 });
      await sql`INSERT INTO public.backup_transcript_fixture VALUES (9999, ${Buffer.from('later row')}, 'after baseline')`;
      await exec('bash', ['-c', `${harness}\n${transcriptCall!.trim().replace(/^if /, '').replace(/; then$/, '')}`],
        { env, timeout: 120_000, maxBuffer: 1024 * 1024 });
      expect(await values(sql)).not.toEqual(originalValues);
    } finally {
      await snapshot.unsafe('ROLLBACK');
      snapshot.release();
    }

    const archives = [];
    for (const [suffix, database] of [
      ['baseline', 'backup_restore_plain'], ['transcript', 'backup_restore_zstd'],
    ] as const) {
      const path = join(work, `postgres-${suffix}`);
      const toc = await exec(join(bin, 'pg_restore'), ['--list', path]);
      expect(toc.stdout).toMatch(/TABLE DATA public backup_transcript_fixture/);
      const files = await archiveFiles(path);
      expect(files.some(file => file.name === 'toc.dat')).toBe(true);
      expect(files.some(file => file.name.endsWith(suffix === 'transcript' ? '.dat.zst' : '.dat'))).toBe(true);
      const bytes = files.reduce((total, file) => total + file.bytes, 0);
      archives.push({ suffix, bytes, files });
      await sql.unsafe(`CREATE DATABASE ${database}`);
      const destination = new URL(pg.getConnectionUri());
      destination.pathname = `/${database}`;
      await exec(join(bin, 'pg_restore'), ['--exit-on-error', '--dbname', destination.toString(), path],
        { timeout: 120_000, maxBuffer: 1024 * 1024 });
      const restoredSql = postgres(destination.toString(), { max: 1, onnotice: () => {} });
      restored.push(restoredSql);
      const actual = await values(restoredSql);
      expect(actual).toHaveLength(rowCount);
      expect(actual.map(row => row.id)).toEqual(expected.map(row => row.id));
      expect(actual).toEqual(expected);
      expect(createHash('sha256').update(JSON.stringify(actual)).digest('hex')).toBe(sourceDigest);
    }
    const [uncompressed, compressed] = archives;
    const ratio = compressed.bytes / uncompressed.bytes;
    const evidence = { seed, construction: 'SHA256(seed || uint32be(counter))',
      rowCount, binaryBytes: rowCount * bytesPerRow, sourceDigest,
      producerSha256: createHash('sha256').update(source).digest('hex'),
      serverVersionNum: server.version, dumpVersion: dumpVersion.stdout.trim(),
      restoreVersion: restoreVersion.stdout.trim(), archives, ratio };
    // Vitest's JSON reporter persists task metadata, but drops annotations.
    // Keep the raw byte totals/digests in the ordinary machine-readable result.
    context.task.meta.nativeBackupFixture = evidence;
    await context.annotate(JSON.stringify(evidence), 'native-backup-fixture');
    expect(uncompressed.bytes).toBeGreaterThan(12 * 1024 * 1024);
    expect(ratio).toBeLessThanOrEqual(0.65);
  } finally {
    await Promise.all(restored.map(connection => connection.end({ timeout: 5 })));
    await sql.end({ timeout: 5 });
    await pg.stop();
    await rm(work, { recursive: true, force: true });
  }
}, 180_000);
