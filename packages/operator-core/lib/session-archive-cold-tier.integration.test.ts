import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

const h = vi.hoisted(() => ({ sql: undefined as unknown as Sql, coldRoot: '', replicaRoot: '', rolloutEnabled: true }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: h.sql }) }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: async () => h.rolloutEnabled }));
// Simulate the separate device boundary while retaining real files, fsync and
// PostgreSQL transactions. Physical mount acceptance remains a live check.
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, stat: async (path: string) => {
    const info = await actual.stat(path);
    return path === h.coldRoot ? Object.assign(info, { dev: info.dev + 1 }) :
      path === h.replicaRoot ? Object.assign(info, { dev: info.dev + 2 }) : info;
  } };
});
import { exportArchiveToColdTier, findArchivedSessionIdForAdv, migrateArchiveToColdTier,
  pgSessionArchiveStore, rematerializeSession, runScheduledColdArchiveMigration, sha256Hex, type ArchiveFileRow, type ArchiveStampRow } from './session-archive';

let db: MigratedTestDb;
const roots: string[] = [];
const migrationRoot = new URL('../../../libs/papercusp/libs/db/sql/', import.meta.url);
const migration = (name: string) => readFile(new URL(name, migrationRoot), 'utf8')
  .catch(() => readFile(new URL(name + '.DRAFT', migrationRoot), 'utf8'));

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'archive_cold' });
  h.sql = postgres(db.url, { max: 4, prepare: false, onnotice: () => {} });
  await h.sql.unsafe('CREATE SCHEMA harness_shared; CREATE TABLE harness_shared.adv_sessions (id bigint PRIMARY KEY, ended_at timestamptz)');
  await h.sql.unsafe(await migration('539-session-archives.sql'));
  await h.sql.unsafe(await migration('1520-session-archive-cold-storage.sql'));
});
beforeEach(async () => { h.rolloutEnabled = true; await h.sql.unsafe('TRUNCATE harness_shared.session_archives, harness_shared.session_archive_files'); });
afterEach(async () => { h.coldRoot = ''; h.replicaRoot = ''; vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
afterAll(async () => { await h.sql?.end({ timeout: 5 }); await db?.drop(); });

async function fixture(raw = Buffer.from('original transcript\n')) {
  const root = await mkdtemp(join(tmpdir(), 'archive-pg-cold-')); roots.push(root);
  const source = await mkdtemp(join(tmpdir(), 'archive-remat-')); roots.push(source);
  const blob = zstdCompressSync(raw);
  const row: ArchiveFileRow = { workspace_id: 'default', source_kind: 'codex', session_id: 'sid-1',
    relpath: 'rollout-sid-1.jsonl', codec: 'zstd', blob, sha256: sha256Hex(raw),
    bytes_raw: raw.length, bytes_stored: blob.length, mtime: new Date('2026-10-01T12:00:00Z') };
  const stamp: ArchiveStampRow = { workspace_id: 'default', source_kind: 'codex', session_id: 'sid-1',
    owner: 'su-test', harness_slug: 'papercusp', cwd: '/work', adv_session_id: 42, session_root: source,
    file_count: 1, bytes_raw: raw.length, bytes_stored: blob.length, archived_by: 'test',
    manifest: [{ relpath: row.relpath, sha256: row.sha256, bytes_raw: raw.length, short_user_turns_offset: 7 }] };
  await pgSessionArchiveStore().upsertArchive([row], stamp);
  return { root, source, stamp, row, raw, store: pgSessionArchiveStore() };
}

describe('cold archive migration on real PostgreSQL', () => {
  it('preserves PG payloads while the scheduled destructive cutover is unarmed', async () => {
    const f = await fixture(); h.rolloutEnabled = false;
    expect(await runScheduledColdArchiveMigration({ root: f.root })).toMatchObject({
      scanned: 0, migrated: 0, skipped: 'rollout_not_enabled',
    });
    expect(await h.sql`SELECT session_id FROM harness_shared.session_archive_files`).toHaveLength(1);
    expect((await f.store.readStamp('codex', 'sid-1'))?.cold_storage).toBeNull();
  });

  it('retains discovery/index metadata and rematerializes bytes after deleting only PG blobs', async () => {
    const f = await fixture();
    expect(await migrateArchiveToColdTier('codex', 'sid-1', f.root, f.store)).toMatchObject({ ok: true, fileCount: 1 });
    expect(await h.sql`SELECT relpath FROM harness_shared.session_archive_files`).toHaveLength(0);
    expect(await h.sql`SELECT session_id FROM harness_shared.session_archives WHERE owner = 'su-test'`).toHaveLength(1);
    expect(await findArchivedSessionIdForAdv(42)).toBe('sid-1');
    const stamp = await f.store.readStamp('codex', 'sid-1');
    expect(stamp?.manifest[0]?.short_user_turns_offset).toBe(7);
    expect(stamp?.cold_storage?.root).toBe(f.root);
    expect((await f.store.readFiles('codex', 'sid-1'))[0]?.mtime).toEqual(f.row.mtime);
    expect(await rematerializeSession({ sourceKind: 'codex', sessionId: 'sid-1' }, f.store)).toMatchObject({ ok: true, written: 1 });
    expect(await readFile(join(f.source, f.row.relpath))).toEqual(f.raw);
    expect(await migrateArchiveToColdTier('codex', 'sid-1', '/ignored-on-replay', f.store)).toMatchObject({ ok: true, bytesStored: 0 });
  });

  it('refuses a stale export after a rewrite and retains newer PG payloads', async () => {
    const f = await fixture(); const before = (await f.store.readStamp('codex', 'sid-1'))!;
    const exported = await exportArchiveToColdTier(before, await f.store.readFiles('codex', 'sid-1'), f.root);
    const newer = Buffer.from('newer transcript\n'); const blob = zstdCompressSync(newer);
    const row = { ...f.row, blob, sha256: sha256Hex(newer), bytes_raw: newer.length, bytes_stored: blob.length };
    const stamp = { ...f.stamp, bytes_raw: row.bytes_raw, bytes_stored: row.bytes_stored,
      manifest: [{ ...f.stamp.manifest[0]!, sha256: row.sha256, bytes_raw: row.bytes_raw }] };
    await f.store.upsertArchive([row], stamp);
    await expect(f.store.moveArchivePayloadsToCold!(before, exported.location)).rejects.toThrow('changed during');
    expect((await f.store.readFiles('codex', 'sid-1'))[0]?.blob).toEqual(blob);
    expect((await f.store.readStamp('codex', 'sid-1'))?.cold_storage).toBeNull();
    expect(await migrateArchiveToColdTier('codex', 'sid-1', f.root, f.store)).toMatchObject({ ok: true });
    expect((await f.store.readFiles('codex', 'sid-1'))[0]?.blob).toEqual(blob);
  });

  it('rolls back the locator when blob deletion fails and reports damaged cold data', async () => {
    const f = await fixture();
    await h.sql.unsafe(`CREATE FUNCTION harness_shared.refuse_archive_delete() RETURNS trigger LANGUAGE plpgsql AS
      'BEGIN RAISE EXCEPTION ''delete refused''; END';
      CREATE TRIGGER refuse_archive_delete BEFORE DELETE ON harness_shared.session_archive_files
      FOR EACH ROW EXECUTE FUNCTION harness_shared.refuse_archive_delete()`);
    try {
      await expect(migrateArchiveToColdTier('codex', 'sid-1', f.root, f.store)).rejects.toThrow('delete refused');
      expect((await f.store.readStamp('codex', 'sid-1'))?.cold_storage).toBeNull();
      expect(await h.sql`SELECT relpath FROM harness_shared.session_archive_files`).toHaveLength(1);
    } finally {
      await h.sql.unsafe('DROP TRIGGER refuse_archive_delete ON harness_shared.session_archive_files; DROP FUNCTION harness_shared.refuse_archive_delete()');
    }
    const result = await migrateArchiveToColdTier('codex', 'sid-1', f.root, f.store);
    await writeFile(join(result.manifestPath!, '..', 'blob-0.zst'), 'damaged');
    await expect(f.store.readFiles('codex', 'sid-1')).rejects.toThrow('checksum');
    expect(await f.store.readStamp('codex', 'sid-1')).not.toBeNull();
  });

  it('bounds each scheduled batch and resumes only the remaining PG payloads', async () => {
    const f = await fixture(); h.coldRoot = f.root;
    const replicaRoot = await mkdtemp(join(tmpdir(), 'archive-replica-')); roots.push(replicaRoot); h.replicaRoot = replicaRoot;
    await f.store.upsertArchive([{ ...f.row, session_id: 'sid-2' }], { ...f.stamp, session_id: 'sid-2' });
    const first = await runScheduledColdArchiveMigration({ root: f.root, replicaRoot, maxArchives: 1 });
    expect(first).toMatchObject({ scanned: 1, migrated: 1, failed: 0, errors: [] });
    expect(await h.sql`SELECT session_id FROM harness_shared.session_archive_files`).toHaveLength(1);
    expect(await runScheduledColdArchiveMigration({ root: f.root, replicaRoot, maxArchives: 1 })).toMatchObject({ scanned: 1, migrated: 1, failed: 0 });
    expect(await runScheduledColdArchiveMigration({ root: f.root, replicaRoot, maxArchives: 1 })).toMatchObject({ scanned: 0, migrated: 0 });
    expect((await f.store.readStamp('codex', 'sid-1'))?.cold_storage?.replicaRoot).toBe(replicaRoot);
    expect((await f.store.readFiles('codex', 'sid-1'))[0]?.blob).toEqual(f.row.blob);
    expect((await f.store.readFiles('codex', 'sid-2'))[0]?.blob).toEqual(f.row.blob);
  });

  it('stops before starting another migration after its deadline', async () => {
    const f = await fixture(); h.coldRoot = f.root;
    const replicaRoot = await mkdtemp(join(tmpdir(), 'archive-replica-')); roots.push(replicaRoot); h.replicaRoot = replicaRoot;
    vi.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValue(600_101);
    expect(await runScheduledColdArchiveMigration({ root: f.root, replicaRoot })).toMatchObject({ scanned: 0, migrated: 0 });
    expect(await h.sql`SELECT session_id FROM harness_shared.session_archive_files`).toHaveLength(1);
  });

  it('retains PG payloads when the required independent cold copy cannot be written', async () => {
    const f = await fixture();
    const missing = join(f.root, 'absent-replica');
    expect(await migrateArchiveToColdTier('codex', 'sid-1', f.root, f.store, missing)).toMatchObject({ ok: false, reason: 'export_failed' });
    expect((await f.store.readStamp('codex', 'sid-1'))?.cold_storage).toBeNull();
    expect(await h.sql`SELECT session_id FROM harness_shared.session_archive_files`).toHaveLength(1);
  });
});
