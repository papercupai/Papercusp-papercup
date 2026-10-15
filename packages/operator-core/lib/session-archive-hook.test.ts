/**
 * End-of-session fast-path tests (session-db-archive-retire-dirs-2026-07-10
 * P-004): the adv-row → archive-ref resolver, and the full run pass with
 * injected deps (no PG): final ingest fires for the transcript, the archive
 * is stamped, the file is deleted, adv gets its archived stamp.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import {
  LIVE_TRANSCRIPT_GRACE_MS,
  assessArchiveLiveness,
  isLiveSkipReason,
  resolveArchiveRefForAdvRow,
  runArchiveForAdvSession,
  type AdvRowForArchive,
  type ArchiveRoots,
} from './session-archive-hook';
import { archiveSession, type ArchiveFileRow, type ArchiveStampRow, type SessionArchiveStore } from './session-archive';
import type { ProtectedSessionIdentity } from './session-dir-gc';

vi.mock('@papercusp/db-org', () => ({ getOrgPg: vi.fn() }));

const SID = 'cccccccc-1111-2222-3333-444444444444';

const ROOTS: ArchiveRoots = {
  claudeSessionRoot: '/sc',
  codexHomeFor: (id) => `/codex-homes/session-${id}`,
  ompRoot: '/omp-sessions',
};

/** Nobody is live/resumable — the pass may proceed on that signal. */
const NOBODY: ProtectedSessionIdentity = { ownerIds: new Set(), sessionKeys: new Set() };

function row(over: Partial<AdvRowForArchive> = {}): AdvRowForArchive {
  return {
    id: 9,
    agent: 'claude',
    mode: 'console',
    cwd: '/repo',
    coord_owner_id: 'su-t',
    session_id: SID,
    ended_at: new Date(Date.now() - 60_000), // what the real loader hands back for an ended row
    ...over,
  };
}

/** Age a file past LIVE_TRANSCRIPT_GRACE_MS — a QUIET transcript, i.e. the
 *  only kind the row-driven pass is allowed to archive+delete. */
async function quiet(abs: string): Promise<void> {
  const old = new Date(Date.now() - LIVE_TRANSCRIPT_GRACE_MS - 5 * 60_000);
  await utimes(abs, old, old);
}

class MiniStore implements SessionArchiveStore {
  files: ArchiveFileRow[] = [];
  stamps = new Map<string, ArchiveStampRow>();
  advStamps: number[] = [];
  async upsertArchive(files: ArchiveFileRow[], stamp: ArchiveStampRow): Promise<void> {
    this.files = files;
    this.stamps.set(`${stamp.source_kind}:${stamp.session_id}`, stamp);
  }
  async readStamp(kind: string, id: string): Promise<ArchiveStampRow | null> {
    return this.stamps.get(`${kind}:${id}`) ?? null;
  }
  async readFiles(kind: string, id: string): Promise<ArchiveFileRow[]> {
    return this.files.filter((f) => f.source_kind === kind && f.session_id === id);
  }
  async stampAdvSessionArchived(advSessionId: number): Promise<void> {
    this.advStamps.push(advSessionId);
  }
}

describe('resolveArchiveRefForAdvRow', () => {
  it('claude → per-owner config dir under the session-claude root', () => {
    const ref = resolveArchiveRefForAdvRow(row(), ROOTS);
    expect(ref).toMatchObject({
      sourceKind: 'claude',
      sessionId: SID,
      sessionRoot: join('/sc', 'su-t'),
      owner: 'su-t',
      advSessionId: 9,
      archivedBy: 'exit-hook',
    });
  });

  it('claude without an owner is unresolvable (disk-side reconciler catches it)', () => {
    expect(resolveArchiveRefForAdvRow(row({ coord_owner_id: null }), ROOTS)).toBeNull();
  });

  it('codex → the per-adv-session CODEX_HOME', () => {
    const ref = resolveArchiveRefForAdvRow(row({ agent: 'codex', id: 7 }), ROOTS);
    expect(ref).toMatchObject({ sourceKind: 'codex', sessionRoot: '/codex-homes/session-7' });
  });

  it('omp → the shared omp sessions root; mode=omp fallback when agent is null', () => {
    expect(resolveArchiveRefForAdvRow(row({ agent: 'omp' }), ROOTS)).toMatchObject({
      sourceKind: 'omp',
      sessionRoot: '/omp-sessions',
    });
    expect(resolveArchiveRefForAdvRow(row({ agent: null, mode: 'omp' }), ROOTS)).toMatchObject({
      sourceKind: 'omp',
    });
  });

  it('no native session id or unknown agent → null', () => {
    expect(resolveArchiveRefForAdvRow(row({ session_id: null }), ROOTS)).toBeNull();
    expect(resolveArchiveRefForAdvRow(row({ agent: 'gemini' }), ROOTS)).toBeNull();
  });

  it('resolves the OMP identity column and its isolated transcript home', () => {
    const ref = resolveArchiveRefForAdvRow(row({
      agent: 'omp', session_id: null, omp_thread_id: SID,
    }), { ...ROOTS, ompRootFor: (id) => `/su-omp-homes/session-${id}/agent/sessions` });
    expect(ref).toMatchObject({
      sourceKind: 'omp', sessionId: SID, sessionRoot: '/su-omp-homes/session-9/agent/sessions',
    });
  });

  it('prefers the OMP column for OMP only, including the legacy mode discriminator', () => {
    const stale = 'dddddddd-1111-2222-3333-444444444444';
    expect(resolveArchiveRefForAdvRow(row({
      agent: null, mode: 'omp', session_id: stale, omp_thread_id: SID,
    }), ROOTS)?.sessionId).toBe(SID);
    expect(resolveArchiveRefForAdvRow(row({ session_id: null, omp_thread_id: SID }), ROOTS)).toBeNull();
  });
});

describe('runArchiveForAdvSession (injected deps, no PG)', () => {
  let tmp: string | null = null;
  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it('ingests the transcript tail, archives, deletes, stamps adv (quiet file, nobody live, row ended)', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'sa-hook-'));
    await mkdir(join(tmp, 'su-t', 'projects', '-repo'), { recursive: true });
    const abs = join(tmp, 'su-t', 'projects', '-repo', `${SID}.jsonl`);
    await writeFile(abs, '{"type":"user"}\n');
    await quiet(abs);

    const store = new MiniStore();
    const ingested: string[] = [];
    const r = await runArchiveForAdvSession(9, {
      loadRow: async () => row(),
      roots: { ...ROOTS, claudeSessionRoot: tmp },
      store,
      protectedIdentity: NOBODY,
      ingestFile: async (p) => {
        ingested.push(p);
      },
    });

    expect(r.ok).toBe(true);
    expect(r.archive?.fileCount).toBe(1);
    expect(r.delete?.deleted).toBe(1);
    expect(ingested).toEqual([abs]);
    expect(store.stamps.has(`claude:${SID}`)).toBe(true);
    expect(store.advStamps).toEqual([9]);
    expect(existsSync(abs)).toBe(false);
  });

  it('row_not_found / unresolvable are reported, never throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); // the unresolvable path warns by design
    expect(await runArchiveForAdvSession(1, { loadRow: async () => null })).toMatchObject({
      ok: false,
      reason: 'row_not_found',
    });
    expect(
      await runArchiveForAdvSession(2, {
        loadRow: async () => row({ session_id: null }),
        roots: ROOTS,
      }),
    ).toMatchObject({ ok: false, reason: 'unresolvable' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it.each(['claude', 'codex', 'omp'] as const)('archives an intact proven %s transcript normally', async (agent) => {
    tmp = await mkdtemp(join(tmpdir(), 'sa-persisted-positive-'));
    const sessionRoot = agent === 'claude' ? join(tmp, 'su-t') : tmp;
    const rel = agent === 'claude' ? join('projects', '-repo', `${SID}.jsonl`)
      : agent === 'codex' ? join('sessions', '2026', '10', '13', `rollout-2026-10-13_${SID}.jsonl`)
        : join('-repo', `2026-10-13_${SID}.jsonl`);
    const nativeRef = join(sessionRoot, rel);
    await mkdir(join(nativeRef, '..'), { recursive: true });
    const bytes = '{"type":"user","message":{"content":"persisted native frame"}}\n';
    await writeFile(nativeRef, bytes);
    await quiet(nativeRef);
    const store = new MiniStore();
    const ingestFile = vi.fn(async () => {});
    const result = await runArchiveForAdvSession(9, {
      loadRow: async () => row({ agent, port_metadata: { persistenceProof: { persisted: true, nativeRef } } }),
      roots: { claudeSessionRoot: tmp, codexHomeFor: () => tmp!, ompRoot: tmp },
      store, protectedIdentity: NOBODY, ingestFile,
    });
    expect(result).toMatchObject({ ok: true, archive: { fileCount: 1, bytesRaw: Buffer.byteLength(bytes) }, delete: { deleted: 1 } });
    expect(ingestFile).toHaveBeenCalledExactlyOnceWith(nativeRef);
    expect(store.files).toHaveLength(1);
    expect(store.files[0]).toMatchObject({ source_kind: agent, session_id: SID, relpath: rel });
    expect(store.advStamps).toEqual([9]);
    expect(existsSync(nativeRef)).toBe(false);
  });

  it.each(['claude', 'codex', 'omp'] as const)('retains archive responsibility when a proven %s transcript disappears', async (agent) => {
    tmp = await mkdtemp(join(tmpdir(), 'sa-missing-'));
    const store = new MiniStore();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await runArchiveForAdvSession(9, {
        loadRow: async () => row({ agent, port_metadata: { persistenceProof: { persisted: true, nativeRef: join(tmp!, `${SID}.jsonl`) } } }),
        roots: { claudeSessionRoot: tmp, codexHomeFor: () => tmp!, ompRoot: tmp },
        store, protectedIdentity: NOBODY,
      });
      expect(result).toMatchObject({ ok: false, reason: 'missing_persisted_transcript' });
      expect(store.advStamps).toEqual([]);
      expect(store.stamps.size).toBe(0);
      expect(warn).toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it('does not mistake surviving side files for the proven native transcript', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'sa-side-only-'));
    await mkdir(join(tmp, 'su-t', 'todos'), { recursive: true });
    const side = join(tmp, 'su-t', 'todos', `${SID}-agent.json`);
    await writeFile(side, '{}');
    await quiet(side);
    const store = new MiniStore();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await runArchiveForAdvSession(9, {
        loadRow: async () => row({ port_metadata: { persistenceProof: { persisted: true, nativeRef: join(tmp!, 'su-t', 'projects', '-repo', `${SID}.jsonl`) } } }),
        roots: { ...ROOTS, claudeSessionRoot: tmp }, store, protectedIdentity: NOBODY,
      });
      expect(result.reason).toBe('missing_persisted_transcript');
      expect(existsSync(side)).toBe(true);
      expect(store.stamps.size).toBe(0);
    } finally { warn.mockRestore(); }
  });

  it.each(['intact', 'intact-with-side-file', 'missing-row', 'corrupt-blob', 'wrong-native'] as const)('checks the canonical archived transcript (%s) before completing', async (control) => {
    tmp = await mkdtemp(join(tmpdir(), 'sa-archived-proof-'));
    const root = join(tmp, 'su-t');
    await mkdir(join(root, 'projects', '-repo'), { recursive: true });
    const nativeRef = join(root, 'projects', '-repo', `${SID}.jsonl`);
    await writeFile(nativeRef, '{"type":"user","message":{"content":"persisted port frame"}}\n');
    const store = new MiniStore();
    await archiveSession({ sourceKind: 'claude', sessionId: SID, sessionRoot: root }, store);
    await rm(nativeRef);
    const archivedFiles = [...store.files];
    const side = join(root, 'todos', `${SID}-agent.json`);
    if (control === 'intact-with-side-file') {
      await mkdir(join(root, 'todos'), { recursive: true });
      await writeFile(side, '{}');
      await quiet(side);
    }
    const ingestFile = vi.fn(async () => {});
    const intact = control === 'intact' || control === 'intact-with-side-file';
    if (control === 'missing-row') store.files = [];
    if (control === 'corrupt-blob') store.files[0].blob = Buffer.from('corrupt');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const run = () => runArchiveForAdvSession(9, {
        loadRow: async () => row({ port_metadata: { persistenceProof: { persisted: true, nativeRef: control === 'wrong-native' ? join(root, `${SID}-other.jsonl`) : nativeRef } } }),
        roots: { ...ROOTS, claudeSessionRoot: tmp! }, store, protectedIdentity: NOBODY, ingestFile,
      });
      if (control === 'corrupt-blob') await expect(run()).rejects.toThrow();
      else expect(await run()).toMatchObject(intact
        ? { ok: true, reason: 'already_archived' }
        : { ok: false, reason: 'missing_persisted_transcript' });
      expect(store.advStamps).toEqual(intact ? [9] : []);
      expect(store.stamps.size).toBe(1);
      expect(ingestFile).not.toHaveBeenCalled();
      if (control === 'intact-with-side-file') {
        expect(existsSync(side)).toBe(true);
        expect(store.files).toEqual(archivedFiles);
      }
    } finally { warn.mockRestore(); }
  });

  it.each(['claude', 'codex', 'omp'] as const)('retains a missing indexed legacy %s transcript without port metadata', async (agent) => {
    tmp = await mkdtemp(join(tmpdir(), 'sa-legacy-missing-'));
    const store = new MiniStore();
    const ingestFile = vi.fn(async () => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await runArchiveForAdvSession(9, {
        loadRow: async () => row({ agent, port_metadata: null,
          ingestedTranscripts: [{ nativeRef: join(tmp!, `${SID}.jsonl`), byteOffset: 100 }] }),
        roots: { claudeSessionRoot: tmp, codexHomeFor: () => tmp!, ompRoot: tmp },
        store, protectedIdentity: NOBODY, ingestFile,
      });
      expect(result).toMatchObject({ ok: false, reason: 'missing_persisted_transcript' });
      expect(store.advStamps).toEqual([]);
      expect(store.stamps.size).toBe(0);
      expect(ingestFile).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it.each(['intact', 'short-archive', 'short-native', 'partial-archive'] as const)(
    'requires complete indexed legacy custody (%s), preserving an existing archive', async (control) => {
      tmp = await mkdtemp(join(tmpdir(), 'sa-legacy-custody-'));
      const root = join(tmp, 'su-t');
      const nativeRef = join(root, 'projects', '-repo', `${SID}.jsonl`);
      const bytes = '{"type":"user","message":{"content":"indexed original native frame"}}\n';
      await mkdir(join(nativeRef, '..'), { recursive: true });
      await writeFile(nativeRef, bytes);
      const store = new MiniStore();
      await archiveSession({ sourceKind: 'claude', sessionId: SID, sessionRoot: root }, store);
      await rm(nativeRef);
      if (control === 'short-native') {
        await writeFile(nativeRef, '{}\n');
        await quiet(nativeRef);
        store.files = [];
      }
      const archivedFiles = [...store.files];
      const ingestFile = vi.fn(async () => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = await runArchiveForAdvSession(9, {
          loadRow: async () => row({ port_metadata: null, ingestedTranscripts: [
            { nativeRef, byteOffset: Buffer.byteLength(bytes) + (control === 'short-archive' ? 1 : 0) },
            ...(control === 'partial-archive' ? [{ nativeRef: join(root, 'projects', '-other', `${SID}.jsonl`), byteOffset: 10 }] : []),
          ] }),
          roots: { ...ROOTS, claudeSessionRoot: tmp! }, store, protectedIdentity: NOBODY, ingestFile,
        });
        expect(result).toMatchObject(control === 'intact'
          ? { ok: true, reason: 'already_archived' }
          : { ok: false, reason: 'missing_persisted_transcript' });
        expect(store.advStamps).toEqual(control === 'intact' ? [9] : []);
        expect(store.files).toEqual(archivedFiles);
        expect(ingestFile).not.toHaveBeenCalled();
        if (control === 'short-native') expect(existsSync(nativeRef)).toBe(true);
      } finally { warn.mockRestore(); }
    },
  );

  it.each(['indexed', 'empty'] as const)('loads legacy custody through the bounded production ingest query (%s)', async (control) => {
    tmp = await mkdtemp(join(tmpdir(), 'sa-legacy-loader-'));
    const root = join(tmp, 'su-t');
    const nativeRef = join(root, 'projects', '-repo', `${SID}.jsonl`);
    const sql = vi.fn().mockResolvedValueOnce([row({ port_metadata: null })])
      .mockResolvedValueOnce(control === 'indexed' ? [{ file_path: nativeRef, byte_offset: '100' }] : []);
    vi.mocked(getOrgPg).mockReturnValue({ sql } as unknown as ReturnType<typeof getOrgPg>);
    const store = new MiniStore();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await runArchiveForAdvSession(9, {
        roots: { ...ROOTS, claudeSessionRoot: tmp! }, store, protectedIdentity: NOBODY,
      });
      expect(result.reason).toBe(control === 'indexed' ? 'missing_persisted_transcript' : 'no_files');
      expect(sql).toHaveBeenCalledTimes(2);
      expect(sql.mock.calls[1].slice(1)).toEqual(['claude', `${root}/`, `${root}/\uffff`, SID]);
      expect(store.advStamps).toEqual([]);
    } finally { warn.mockRestore(); vi.mocked(getOrgPg).mockReset(); }
  });

  it('keeps the normal no-persistence empty-session result', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'sa-no-persistence-'));
    const store = new MiniStore();
    const result = await runArchiveForAdvSession(9, {
      loadRow: async () => row({ port_metadata: { persistenceProof: { persisted: false } } }),
      roots: { ...ROOTS, claudeSessionRoot: tmp }, store, protectedIdentity: NOBODY,
    });
    expect(result).toMatchObject({ ok: false, reason: 'no_files' });
    expect(store.advStamps).toEqual([]);
  });

  it('does not clear an unresolvable row with previously proven persistence', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await runArchiveForAdvSession(9, {
        loadRow: async () => row({ session_id: null, port_metadata: { persistenceProof: { persisted: true } } }), roots: ROOTS,
      });
      expect(result).toMatchObject({ ok: false, reason: 'missing_persisted_transcript' });
    } finally { warn.mockRestore(); }
  });

  it('archives the tracked OMP transcript with no session_id and keeps a neighboring session', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'sa-hook-omp-'));
    const sessionRoot = join(tmp, 'agent', 'sessions');
    await mkdir(join(sessionRoot, '-repo'), { recursive: true });
    const abs = join(sessionRoot, '-repo', `2026-09-08_${SID}.jsonl`);
    const neighbor = join(sessionRoot, '-repo', '2026-09-08_another-session.jsonl');
    await writeFile(abs, '{"type":"session"}\n');
    await writeFile(neighbor, 'neighbor\n');
    await quiet(abs);
    const store = new MiniStore();
    const ingested: string[] = [];
    const result = await runArchiveForAdvSession(9, {
      loadRow: async () => row({ agent: 'omp', session_id: null, omp_thread_id: SID }),
      roots: { ...ROOTS, ompRootFor: () => sessionRoot }, store, protectedIdentity: NOBODY,
      ingestFile: async (p) => { ingested.push(p); },
    });
    expect(result.ok).toBe(true);
    expect(ingested).toEqual([abs]);
    expect(store.stamps.has(`omp:${SID}`)).toBe(true);
    expect(store.advStamps).toEqual([9]);
    expect(existsSync(abs)).toBe(false);
    expect(existsSync(neighbor)).toBe(true);
  });

  it('an ingest failure never blocks archival (the archive preserves the bytes)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); // per-file ingest failure warns by design
    tmp = await mkdtemp(join(tmpdir(), 'sa-hook2-'));
    await mkdir(join(tmp, 'su-t', 'projects', '-repo'), { recursive: true });
    const abs = join(tmp, 'su-t', 'projects', '-repo', `${SID}.jsonl`);
    await writeFile(abs, 'x\n');
    await quiet(abs);
    const store = new MiniStore();
    const r = await runArchiveForAdvSession(9, {
      loadRow: async () => row(),
      roots: { ...ROOTS, claudeSessionRoot: tmp },
      store,
      protectedIdentity: NOBODY,
      ingestFile: async () => {
        throw new Error('pg down');
      },
    });
    expect(r.ok).toBe(true);
    expect(store.stamps.size).toBe(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

/**
 * LIVENESS GUARD (EI-22126624550252124 / WI-2140943). The regression: adv 22047
 * (da701a71) was resume-finalized at 04:04:19Z, a stale 'self' end landed at
 * 04:04:45Z, and the hook archived+DELETED the transcript at 04:05:00Z while the
 * CLI was still appending (734,384B → 949,887B between two deletes). Every
 * safety net that READS the jsonl (compaction watchdog, death detector) went dark
 * and the session died at the context limit with no carry. The three signals
 * below each refuse the pass on their own; the control above proves a quiet,
 * unprotected, ended session still archives — the guard must be falsifiable.
 */
describe('runArchiveForAdvSession — LIVENESS GUARD never deletes a live transcript', () => {
  let tmp: string | null = null;
  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
    tmp = null;
  });

  async function liveTranscript(): Promise<{ abs: string; root: string }> {
    tmp = await mkdtemp(join(tmpdir(), 'sa-live-'));
    await mkdir(join(tmp, 'su-t', 'projects', '-repo'), { recursive: true });
    const abs = join(tmp, 'su-t', 'projects', '-repo', `${SID}.jsonl`);
    await writeFile(abs, '{"type":"user"}\n{"type":"assistant"}\n'); // fresh mtime = a CLI is appending
    return { abs, root: tmp };
  }

  it('the da701a71 shape: row says ended, file is FRESH → refused, nothing touched, not even ingested', async () => {
    const { abs, root } = await liveTranscript();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = new MiniStore();
    const ingested: string[] = [];
    const r = await runArchiveForAdvSession(9, {
      loadRow: async () => row(), // ended_at set — exactly what the stale end-report left behind
      roots: { ...ROOTS, claudeSessionRoot: root },
      store,
      protectedIdentity: NOBODY, // even with NO presence signal, the mtime alone refuses
      ingestFile: async (p) => {
        ingested.push(p);
      },
    });
    expect(r).toMatchObject({ ok: false, reason: 'transcript_fresh' });
    expect(r.liveEvidence).toMatch(/modified \d+s ago/);
    expect(existsSync(abs)).toBe(true);
    expect(store.stamps.size).toBe(0);
    expect(store.advStamps).toEqual([]); // never stamped out of the reconciler's scan set
    expect(ingested).toEqual([]);
    expect(log.mock.calls.some((c) => String(c[0]).includes('looks LIVE'))).toBe(true);
    log.mockRestore();
  });

  it('row re-opened (ended_at NULL at pass time) → refused even when the file is quiet', async () => {
    const { abs, root } = await liveTranscript();
    await quiet(abs);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = new MiniStore();
    const r = await runArchiveForAdvSession(9, {
      loadRow: async () => row({ ended_at: null }),
      roots: { ...ROOTS, claudeSessionRoot: root },
      store,
      protectedIdentity: NOBODY,
      ingestFile: async () => {},
    });
    expect(r).toMatchObject({ ok: false, reason: 'row_reopened' });
    expect(existsSync(abs)).toBe(true);
    expect(store.stamps.size).toBe(0);
    vi.mocked(console.log).mockRestore();
  });

  it('owner in the protected set (live presence / open adv / pending wake) → refused even when quiet + ended', async () => {
    const { abs, root } = await liveTranscript();
    await quiet(abs);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = new MiniStore();
    const r = await runArchiveForAdvSession(9, {
      loadRow: async () => row(),
      roots: { ...ROOTS, claudeSessionRoot: root },
      store,
      protectedIdentity: { ownerIds: new Set(['su-t']), sessionKeys: new Set() },
      ingestFile: async () => {},
    });
    expect(r).toMatchObject({ ok: false, reason: 'owner_live' });
    expect(existsSync(abs)).toBe(true);
    expect(store.stamps.size).toBe(0);
    vi.mocked(console.log).mockRestore();
  });

  it('DEGRADED protected set counts as protected — fail closed, like the disk sweep', async () => {
    const { abs, root } = await liveTranscript();
    await quiet(abs);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = new MiniStore();
    const r = await runArchiveForAdvSession(9, {
      loadRow: async () => row(),
      roots: { ...ROOTS, claudeSessionRoot: root },
      store,
      protectedIdentity: { ...NOBODY, degraded: true },
      ingestFile: async () => {},
    });
    expect(r).toMatchObject({ ok: false, reason: 'owner_live' });
    expect(r.liveEvidence).toMatch(/DEGRADED/);
    expect(existsSync(abs)).toBe(true);
    vi.mocked(console.log).mockRestore();
  });

  it('every live-skip reason is classified as such (the reconciler keys off this)', () => {
    for (const r of ['row_reopened', 'transcript_fresh', 'owner_live']) expect(isLiveSkipReason(r)).toBe(true);
    for (const r of ['no_files', 'unresolvable', 'row_not_found', 'changed_during_read', undefined]) {
      expect(isLiveSkipReason(r)).toBe(false);
    }
  });
});

describe('assessArchiveLiveness (pure boundary)', () => {
  const ref = { sourceKind: 'claude' as const, sessionId: SID };
  const ended = { id: 9, coord_owner_id: 'su-t', ended_at: new Date(0) };
  const rel = `projects/-repo/${SID}.jsonl`;

  it('exactly at the grace is quiet; one ms inside it is fresh', () => {
    const nowMs = 1_000_000_000;
    const atGrace = assessArchiveLiveness({
      row: ended, ref, protectedIdentity: NOBODY, nowMs,
      files: [{ rel, mtimeMs: nowMs - LIVE_TRANSCRIPT_GRACE_MS }],
    });
    expect(atGrace).toBeNull();
    const inside = assessArchiveLiveness({
      row: ended, ref, protectedIdentity: NOBODY, nowMs,
      files: [{ rel, mtimeMs: nowMs - LIVE_TRANSCRIPT_GRACE_MS + 1 }],
    });
    expect(inside?.reason).toBe('transcript_fresh');
  });

  it('only SESSION-KEYED files count — a fresh directory-shared file (a codex config.toml) never blocks', () => {
    const nowMs = 1_000_000_000;
    const codexRef = { sourceKind: 'codex' as const, sessionId: SID };
    const r = assessArchiveLiveness({
      row: { id: 7, coord_owner_id: null, ended_at: new Date(0) },
      ref: codexRef,
      protectedIdentity: NOBODY,
      nowMs,
      files: [
        { rel: 'config.toml', mtimeMs: nowMs }, // shared, fresh — irrelevant
        { rel: `sessions/2026/09/02/rollout-2026-09-02T00-00-00-${SID}.jsonl`, mtimeMs: nowMs - 2 * LIVE_TRANSCRIPT_GRACE_MS },
      ],
    });
    expect(r).toBeNull();
  });

  it('codex rows are protected by ADV ID (sessionKeys), claude rows by OWNER (ownerIds)', () => {
    const nowMs = 1_000_000_000;
    const codex = assessArchiveLiveness({
      row: { id: 7, coord_owner_id: null, ended_at: new Date(0) },
      ref: { sourceKind: 'codex', sessionId: SID },
      protectedIdentity: { ownerIds: new Set(), sessionKeys: new Set(['7']) },
      nowMs,
      files: [],
    });
    expect(codex?.reason).toBe('owner_live');
    const claudeOtherOwner = assessArchiveLiveness({
      row: ended,
      ref,
      protectedIdentity: { ownerIds: new Set(['someone-else']), sessionKeys: new Set(['9']) },
      nowMs,
      files: [],
    });
    expect(claudeOtherOwner).toBeNull();
  });

  it('an unloaded ended_at (legacy row) gives no verdict; NULL means re-opened', () => {
    const nowMs = 1_000_000_000;
    expect(assessArchiveLiveness({ row: { id: 9, coord_owner_id: 'su-t' }, ref, protectedIdentity: NOBODY, nowMs, files: [] })).toBeNull();
    expect(
      assessArchiveLiveness({ row: { id: 9, coord_owner_id: 'su-t', ended_at: null }, ref, protectedIdentity: NOBODY, nowMs, files: [] })?.reason,
    ).toBe('row_reopened');
  });
});
