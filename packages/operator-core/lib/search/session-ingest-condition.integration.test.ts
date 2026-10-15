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
      (file_path, source_kind, byte_offset, updated_at)
      VALUES (${path}, 'codex', 0, now() - interval '46 days')`;
    const now = Date.now(), hour = 3600_000;
    expect(await readIngestBacklogRecovery('codex', path, hour, now)).toBe(false);
    expect(await readIngestBacklogRecovery('claude', path, hour, now)).toBeNull();
    expect(await readIngestBacklogRecovery('codex', path + '-absent', hour, now)).toBeNull();
    await db.adminSql`UPDATE harness_shared.session_ingest_state SET byte_offset = ${bytes}
      WHERE file_path = ${path} AND source_kind = 'codex'`;
    expect(await readIngestBacklogRecovery('codex', path, hour, now)).toBe(true);
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
