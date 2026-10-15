import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { exportArchiveToColdTier, migrateArchiveToColdTier, readColdArchiveFiles, readColdArchiveStamp, sha256Hex, type ArchiveFileRow, type ArchiveStampRow, type SessionArchiveStore } from './session-archive';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function fixture(raw = Buffer.from('archived transcript\n')): { stamp: ArchiveStampRow; row: ArchiveFileRow } {
  const blob = zstdCompressSync(raw);
  const row: ArchiveFileRow = {
    workspace_id: 'default', source_kind: 'codex', session_id: 'sid-1', relpath: 'sessions/2026/10/rollout-sid-1.jsonl',
    codec: 'zstd', blob, sha256: sha256Hex(raw), bytes_raw: raw.length, bytes_stored: blob.length, mtime: null,
  };
  return { row, stamp: {
    workspace_id: 'default', source_kind: 'codex', session_id: 'sid-1', owner: null, harness_slug: 'papercusp', cwd: null,
    adv_session_id: null, session_root: '/tmp/session', file_count: 1, bytes_raw: raw.length, bytes_stored: blob.length,
    manifest: [{ relpath: row.relpath, sha256: row.sha256, bytes_raw: row.bytes_raw }], archived_by: 'test',
  } };
}

describe('session archive cold-tier export', () => {
  it('writes verified zstd bytes and a read-back manifest, idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-cold-')); roots.push(root);
    const { stamp, row } = fixture();
    const first = await exportArchiveToColdTier(stamp, [row], root);
    const second = await exportArchiveToColdTier(stamp, [row], root);
    expect(first).toEqual(second);
    expect(JSON.parse(await readFile(first.manifestPath, 'utf8')).files).toHaveLength(1);
    const coldStamp = await readColdArchiveStamp('codex', 'sid-1', root);
    expect(coldStamp).toMatchObject({ file_count: 1, bytes_raw: row.bytes_raw });
    expect(await readColdArchiveFiles(coldStamp!, root)).toMatchObject([{ sha256: row.sha256, bytes_stored: row.bytes_stored }]);
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
      deleteArchiveRows: async (value) => { deleted.push(value); },
      upsertArchive: async () => {},
      stampAdvSessionArchived: async () => {},
    };
    await expect(migrateArchiveToColdTier('codex', 'sid-1', root, store)).resolves.toMatchObject({ ok: true, fileCount: 1 });
    expect(deleted).toHaveLength(1);
  });
});
