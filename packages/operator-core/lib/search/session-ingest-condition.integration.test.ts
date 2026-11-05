import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as org from '@papercusp/db-org';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { mockOrgPgSql } from '../testing/mock-org-pg';
import { readIngestBacklogRecovery } from './session-ingest-lag-watchdog';

describe('ingest exact recovery (real migrated PostgreSQL and files)', () => {
  let db: OrgTestDb, directory: string;
  beforeAll(async () => {
    db = await createOrgTestDb(); directory = await mkdtemp(join(tmpdir(), 'ingest-condition-'));
    vi.spyOn(org, 'getOrgPg');
    mockOrgPgSql(vi.mocked(org.getOrgPg), db.adminSql);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    if (directory) await rm(directory, { recursive: true, force: true });
    await db?.cleanup();
  });

  it('recovers an exact old affected file outside the 45-day candidate window and preserves foreign/missing rows', async () => {
    const path = join(directory, 'old.jsonl'), bytes = 128 * 1024;
    await writeFile(path, 'x'.repeat(bytes - 1) + '\n');
    await db.adminSql`INSERT INTO harness_shared.session_ingest_state
      (file_path, source_kind, byte_offset, byte_offset_changed_at, updated_at)
      VALUES (${path}, 'codex', 0, now() - interval '46 days', now() - interval '46 days')`;
    const now = Date.now(), hour = 3600_000;
    expect(await readIngestBacklogRecovery('codex', path, hour, now)).toBe(false);
    expect(await readIngestBacklogRecovery('claude', path, hour, now)).toBeNull();
    expect(await readIngestBacklogRecovery('codex', path + '-absent', hour, now)).toBeNull();
    await db.adminSql`UPDATE harness_shared.session_ingest_state SET byte_offset = ${bytes}
      WHERE file_path = ${path} AND source_kind = 'codex'`;
    expect(await readIngestBacklogRecovery('codex', path, hour, now)).toBe(true);
  });

  it('keeps the migration marker tied to primary byte_offset changes', async () => {
    const path = join(directory, 'marker.jsonl');
    const stale = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    await db.adminSql`INSERT INTO harness_shared.session_ingest_state
      (file_path, source_kind, byte_offset, byte_offset_changed_at, updated_at)
      VALUES (${path}, 'codex', 0, ${stale}, ${stale})`;
    const [before] = await db.adminSql`SELECT byte_offset_changed_at::text AS marker,
      updated_at::text AS updated FROM harness_shared.session_ingest_state
      WHERE file_path = ${path} AND source_kind = 'codex'`;
    const beforeMarker = String((before as { marker: unknown }).marker);
    const beforeUpdated = String((before as { updated: unknown }).updated);

    await db.adminSql`UPDATE harness_shared.session_ingest_state
      SET updated_at = now() + interval '1 day'
      WHERE file_path = ${path} AND source_kind = 'codex'`;
    const [afterAuxiliaryWrite] = await db.adminSql`SELECT byte_offset_changed_at::text AS marker,
      updated_at::text AS updated FROM harness_shared.session_ingest_state
      WHERE file_path = ${path} AND source_kind = 'codex'`;
    expect(String((afterAuxiliaryWrite as { marker: unknown }).marker)).toBe(beforeMarker);
    expect(Date.parse(String((afterAuxiliaryWrite as { updated: unknown }).updated)))
      .toBeGreaterThan(Date.parse(beforeUpdated));

    await db.adminSql`UPDATE harness_shared.session_ingest_state SET byte_offset = 1,
      updated_at = now() + interval '2 days'
      WHERE file_path = ${path} AND source_kind = 'codex'`;
    const [afterByteProgress] = await db.adminSql`SELECT byte_offset_changed_at::text AS marker,
      updated_at::text AS updated FROM harness_shared.session_ingest_state
      WHERE file_path = ${path} AND source_kind = 'codex'`;
    const advancedMarker = Date.parse(String((afterByteProgress as { marker: unknown }).marker));
    expect(advancedMarker).toBeGreaterThan(Date.parse(beforeMarker));
    expect(advancedMarker).toBeLessThan(Date.parse(String((afterByteProgress as { updated: unknown }).updated)));
  });

  it('distinguishes incomplete tails, rotated files and missing files from consumed work', async () => {
    const path = join(directory, 'tail.jsonl'), bytes = 128 * 1024;
    await writeFile(path, 'x'.repeat(bytes));
    await db.adminSql`INSERT INTO harness_shared.session_ingest_state
      (file_path, source_kind, byte_offset, updated_at)
      VALUES (${path}, 'codex', 0, now() - interval '2 hours')`;
    const now = Date.now(), hour = 3600_000;
    expect(await readIngestBacklogRecovery('codex', path, hour, now)).toBe(true);
    await db.adminSql`UPDATE harness_shared.session_ingest_state SET byte_offset = ${bytes + 1}
      WHERE file_path = ${path} AND source_kind = 'codex'`;
    expect(await readIngestBacklogRecovery('codex', path, hour, now)).toBeNull();
    await rm(path);
    await expect(readIngestBacklogRecovery('codex', path, hour, now)).rejects.toThrow();
  });
});
