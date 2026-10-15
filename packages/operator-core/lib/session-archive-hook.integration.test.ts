/** Exercise the production archive-row loader against a migrated private PG.
 * Only the connection is substituted; loadRow and the archive store are real. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { createOrgTestDb, type OrgTestDb } from '../test/_org-test-db';
import { mockOrgPgSql } from './testing/mock-org-pg';
import { LIVE_TRANSCRIPT_GRACE_MS, runArchiveForAdvSession } from './session-archive-hook';
import { pgSessionArchiveStore } from './session-archive';

vi.mock('@papercusp/db-org', async (original) => ({
  ...await original<typeof import('@papercusp/db-org')>(),
  getOrgPg: vi.fn(),
}));

describe('production archive loader persistence proof', () => {
  let db: OrgTestDb | undefined;
  let root: string | undefined;
  beforeAll(async () => {
    db = await createOrgTestDb();
    mockOrgPgSql(vi.mocked(getOrgPg), db.adminSql);
    root = await mkdtemp(join(tmpdir(), 'archive-loader-pg-'));
  }, 180_000);
  afterAll(async () => {
    try { await db?.cleanup(); }
    finally { if (root) await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  async function seed(agent: 'claude' | 'codex' | 'omp', persisted: boolean) {
    const sid = randomUUID();
    const owner = `archive-loader-${sid}`;
    const sessionRoot = agent === 'claude' ? join(root!, owner) : join(root!, sid);
    const rel = agent === 'claude' ? join('projects', '-repo', `${sid}.jsonl`)
      : agent === 'codex' ? join('sessions', '2026', '10', '13', `rollout-2026-10-13_${sid}.jsonl`)
        : join('-repo', `2026-10-13_${sid}.jsonl`);
    const nativeRef = join(sessionRoot, rel);
    const [row] = await db!.adminSql<Array<{ id: number }>>`
      INSERT INTO harness_shared.adv_sessions
        (workspace_id, mode, agent, cwd, coord_owner_id, session_id, omp_thread_id, ended_at, port_metadata)
      VALUES ('default', 'console', ${agent}, '/repo', ${owner}, ${sid}, ${agent === 'omp' ? sid : null},
        now() - interval '2 hours', ${JSON.stringify({ persistenceProof: { persisted, nativeRef } })}::jsonb)
      RETURNING id`;
    const deps = {
      roots: { claudeSessionRoot: root!, codexHomeFor: () => sessionRoot, ompRoot: sessionRoot },
      protectedIdentity: { ownerIds: new Set<string>(), sessionKeys: new Set<string>() },
      ingestFile: vi.fn(async () => {}),
    };
    return { id: row.id, sid, sessionRoot, rel, nativeRef, deps };
  }

  it.each(['claude', 'codex', 'omp'] as const)('keeps a missing persisted %s transcript pending after reading PG', async (agent) => {
    const fixture = await seed(agent, true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await runArchiveForAdvSession(fixture.id, fixture.deps))
        .toMatchObject({ ok: false, reason: 'missing_persisted_transcript' });
      const [row] = await db!.adminSql`SELECT archived_at FROM harness_shared.adv_sessions WHERE id = ${fixture.id}`;
      expect(row.archived_at).toBeNull();
      expect(await pgSessionArchiveStore().readStamp(agent, fixture.sid)).toBeNull();
      expect(fixture.deps.ingestFile).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it('retains the ordinary empty-session result when PG says persistence was disabled', async () => {
    const fixture = await seed('claude', false);
    expect(await runArchiveForAdvSession(fixture.id, fixture.deps)).toMatchObject({ reason: 'no_files' });
  });

  it('archives an intact transcript into PG and preserves it when only a side file remains', async () => {
    const fixture = await seed('claude', true);
    await mkdir(join(fixture.nativeRef, '..'), { recursive: true });
    await writeFile(fixture.nativeRef, '{"type":"user","message":{"content":"native frame"}}\n');
    const quiet = new Date(Date.now() - LIVE_TRANSCRIPT_GRACE_MS - 60_000);
    await utimes(fixture.nativeRef, quiet, quiet);
    expect(await runArchiveForAdvSession(fixture.id, fixture.deps)).toMatchObject({ ok: true });
    expect(existsSync(fixture.nativeRef)).toBe(false);
    const store = pgSessionArchiveStore();
    const archived = await store.readFiles('claude', fixture.sid);
    expect(archived).toHaveLength(1);
    expect(archived[0].relpath).toBe(fixture.rel);
    const side = join(fixture.sessionRoot, 'todos', `${fixture.sid}-agent.json`);
    await mkdir(join(side, '..'), { recursive: true });
    await writeFile(side, '{}');
    await utimes(side, quiet, quiet);
    fixture.deps.ingestFile.mockClear();
    expect(await runArchiveForAdvSession(fixture.id, fixture.deps))
      .toMatchObject({ ok: true, reason: 'already_archived' });
    expect(existsSync(side)).toBe(true);
    expect(await store.readFiles('claude', fixture.sid)).toEqual(archived);
    expect(fixture.deps.ingestFile).not.toHaveBeenCalled();
  });
});
