import { mkdtemp, readFile, rm, writeFile, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DARK_FLAGS, FLAG_DEFAULTS, FLAGS } from '@papercusp/flags';
const rollout = vi.hoisted(() => ({ getFlag: vi.fn() }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: rollout.getFlag }));
import { assertArchiveColdMount, exportArchiveToColdTier, migrateArchiveToColdTier, readColdArchiveFiles, readColdArchiveStamp, runScheduledColdArchiveMigration, verifyColdArchiveIntegrity, sha256Hex, type ArchiveFileRow, type ArchiveStampRow, type SessionArchiveStore } from './session-archive';

const roots: string[] = [];
beforeEach(() => { rollout.getFlag.mockReset().mockResolvedValue(false); });
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function fixture(raw = Buffer.from('archived transcript\n')): { stamp: ArchiveStampRow; row: ArchiveFileRow } {
  const blob = zstdCompressSync(raw);
  const row: ArchiveFileRow = {
    workspace_id: 'default', source_kind: 'codex', session_id: 'sid-1', relpath: 'sessions/2026/10/rollout-sid-1.jsonl',
    codec: 'zstd', blob, sha256: sha256Hex(raw), bytes_raw: raw.length, bytes_stored: blob.length, mtime: new Date('2026-10-01T12:00:00Z'),
  };
  return { row, stamp: {
    workspace_id: 'default', source_kind: 'codex', session_id: 'sid-1', owner: null, harness_slug: 'papercusp', cwd: null,
    adv_session_id: null, session_root: '/tmp/session', file_count: 1, bytes_raw: raw.length, bytes_stored: blob.length,
    manifest: [{ relpath: row.relpath, sha256: row.sha256, bytes_raw: row.bytes_raw, short_user_turns_offset: 12 }], archived_by: 'test',
  } };
}

describe('session archive cold-tier export', () => {
  it('keeps the destructive schedule dark before reader cutover, without opening PG or cold media', async () => {
    expect(FLAG_DEFAULTS[FLAGS.SESSION_ARCHIVE_COLD_MIGRATION]).toBe(false);
    expect(DARK_FLAGS.get(FLAGS.SESSION_ARCHIVE_COLD_MIGRATION)?.case).toBe('cutover');
    expect(await runScheduledColdArchiveMigration({ root: '/missing-cold-volume' })).toMatchObject({
      scanned: 0, migrated: 0, bytesStored: 0, failed: 0, skipped: 'rollout_not_enabled',
    });
    expect(rollout.getFlag).toHaveBeenCalledWith(FLAGS.SESSION_ARCHIVE_COLD_MIGRATION, 'system');
  });

  it('fails closed before opening PG or cold media when rollout admission is unavailable', async () => {
    rollout.getFlag.mockRejectedValue(new Error('flag backend unavailable'));
    expect(await runScheduledColdArchiveMigration({ root: '/missing-cold-volume' })).toMatchObject({
      scanned: 0, migrated: 0, bytesStored: 0, failed: 0, skipped: 'rollout_not_enabled',
    });
  });

  it('writes verified zstd bytes and a read-back manifest, idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-cold-')); roots.push(root);
    const { stamp, row } = fixture();
    const first = await exportArchiveToColdTier(stamp, [row], root);
    const second = await exportArchiveToColdTier(stamp, [row], root);
    expect(first).toEqual(second);
    expect(JSON.parse(await readFile(first.manifestPath, 'utf8')).files).toHaveLength(1);
    const coldStamp = await readColdArchiveStamp('codex', 'sid-1', first.location);
    expect(coldStamp).toMatchObject({ file_count: 1, bytes_raw: row.bytes_raw });
    expect(coldStamp.manifest[0]?.short_user_turns_offset).toBe(12);
    expect(await readColdArchiveFiles(coldStamp!)).toMatchObject([{ sha256: row.sha256, bytes_stored: row.bytes_stored, mtime: row.mtime }]);
  });

  it('fails closed on a corrupted blob or unsafe manifest path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-cold-')); roots.push(root);
    const { stamp, row } = fixture();
    await expect(exportArchiveToColdTier(stamp, [{ ...row, blob: Buffer.from('bad') }], root)).rejects.toThrow(/mismatch|integrity|decompress/i);
    await expect(exportArchiveToColdTier({ ...stamp, manifest: [{ ...stamp.manifest[0]!, relpath: '../escape' }] }, [row], root)).rejects.toThrow('unsafe archive relpath');
  });

  it('deletes PG rows only after the verified cold export', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-cold-')); roots.push(root);
    const { stamp, row } = fixture();
    const deleted: unknown[] = [];
    const store: SessionArchiveStore = {
      readStamp: async () => stamp,
      readFiles: async () => [row],
      moveArchivePayloadsToCold: async (value, location) => {
        expect(await readColdArchiveFiles({ ...value, cold_storage: location })).toMatchObject([{ blob: row.blob }]);
        deleted.push(value);
      },
      upsertArchive: async () => {},
      stampAdvSessionArchived: async () => {},
    };
    await expect(migrateArchiveToColdTier('codex', 'sid-1', root, store)).resolves.toMatchObject({ ok: true, fileCount: 1 });
    expect(deleted).toHaveLength(1);
  });

  it('leaves the PG store untouched when export fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-cold-')); roots.push(root);
    const { stamp, row } = fixture(); let moved = false;
    const store: SessionArchiveStore = {
      readStamp: async () => stamp, readFiles: async () => [{ ...row, sha256: '0'.repeat(64) }],
      moveArchivePayloadsToCold: async () => { moved = true; }, upsertArchive: async () => {}, stampAdvSessionArchived: async () => {},
    };
    expect(await migrateArchiveToColdTier('codex', 'sid-1', root, store)).toMatchObject({ ok: false, reason: 'export_failed' });
    expect(moved).toBe(false);
  });

  it('uses immutable versions when a session is re-archived with different bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-cold-')); roots.push(root);
    const first = fixture(); const second = fixture(Buffer.from('new transcript\n'));
    const a = await exportArchiveToColdTier(first.stamp, [first.row], root);
    const b = await exportArchiveToColdTier(second.stamp, [second.row], root);
    expect(a.location).not.toEqual(b.location);
    expect((await readColdArchiveFiles({ ...first.stamp, cold_storage: a.location }))[0]?.blob).toEqual(first.row.blob);
    expect((await readColdArchiveFiles({ ...second.stamp, cold_storage: b.location }))[0]?.blob).toEqual(second.row.blob);
  });

  it('rejects corrupted manifest and compressed bytes at read time', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-cold-')); roots.push(root);
    const { stamp, row } = fixture(); const result = await exportArchiveToColdTier(stamp, [row], root);
    await writeFile(join(result.manifestPath, '..', 'blob-0.zst'), 'bad');
    await expect(readColdArchiveFiles({ ...stamp, cold_storage: result.location })).rejects.toThrow('checksum');
    await writeFile(result.manifestPath, '{}');
    await expect(readColdArchiveStamp('codex', 'sid-1', result.location)).rejects.toThrow('checksum');
  });

  it('rejects duplicate manifest entries, foreign row identity and unsafe session keys', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-cold-')); roots.push(root);
    const { stamp, row } = fixture();
    await expect(exportArchiveToColdTier({ ...stamp, file_count: 2, manifest: [stamp.manifest[0]!, stamp.manifest[0]!] },
      [row, { ...row, relpath: 'other' }], root)).rejects.toThrow('duplicated');
    await expect(exportArchiveToColdTier(stamp, [{ ...row, session_id: 'other' }], root)).rejects.toThrow('mismatch');
    await expect(exportArchiveToColdTier({ ...stamp, session_id: '../escape' }, [row], root)).rejects.toThrow('identity');
  });

  it('rejects symlinked cold directories and a missing mount', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-cold-')); roots.push(root);
    const { stamp, row } = fixture(); await mkdir(join(root, 'outside'));
    await symlink(join(root, 'outside'), join(root, 'default'));
    await expect(exportArchiveToColdTier(stamp, [row], root)).rejects.toThrow('not real');
    await expect(assertArchiveColdMount('/')).rejects.toThrow('not mounted separately');
  });

  async function dualCopy() {
    const primary = await mkdtemp(join(tmpdir(), 'session-cold-primary-')); roots.push(primary);
    const replica = await mkdtemp(join(tmpdir(), 'session-cold-replica-')); roots.push(replica);
    const { stamp, row } = fixture();
    const a = await exportArchiveToColdTier(stamp, [row], primary);
    const b = await exportArchiveToColdTier(stamp, [row], replica);
    expect(a.location.manifestSha256).toBe(b.location.manifestSha256);
    return { stamp: { ...stamp, cold_storage: { ...a.location, replicaRoot: replica } }, a, b,
      statRoot: async (path: string) => ({ dev: path === '/' ? 1 : path === primary ? 2 : 3, ino: 10 }) };
  }

  it('reads both actual compressed copies and binds them to the retained PG manifest', async () => {
    const { stamp, statRoot } = await dualCopy();
    expect(await verifyColdArchiveIntegrity(stamp, { statRoot })).toEqual({ fileCount: 1,
      bytesRaw: stamp.bytes_raw, bytesStored: stamp.bytes_stored,
      manifestSha256: stamp.cold_storage.manifestSha256, primaryDevice: 2, replicaDevice: 3 });
    await expect(verifyColdArchiveIntegrity({ ...stamp, manifest: [{ ...stamp.manifest[0]!, sha256: '0'.repeat(64) }] },
      { statRoot })).rejects.toThrow('retained PG index');
  });

  it.each(['primary', 'replica'] as const)('detects a corrupted %s copy without modifying either locator', async which => {
    const { stamp, statRoot, a, b } = await dualCopy();
    await writeFile(join((which === 'primary' ? a : b).manifestPath, '..', 'blob-0.zst'), 'corrupt');
    await expect(verifyColdArchiveIntegrity(stamp, { statRoot })).rejects.toThrow('checksum');
  });

  it('refuses missing replicas, same-volume copies and a remount during verification', async () => {
    const { stamp, statRoot } = await dualCopy();
    await expect(verifyColdArchiveIntegrity({ ...stamp, cold_storage: { ...stamp.cold_storage, replicaRoot: undefined } }))
      .rejects.toThrow('distinct replica');
    await expect(verifyColdArchiveIntegrity(stamp)).rejects.toThrow('independent mounted volumes');
    let calls = 0;
    await expect(verifyColdArchiveIntegrity(stamp, { statRoot: async path => ({ ...await statRoot(path),
      ino: ++calls > 3 ? 20 : 10 }) })).rejects.toThrow('volume changed');
  });
});
