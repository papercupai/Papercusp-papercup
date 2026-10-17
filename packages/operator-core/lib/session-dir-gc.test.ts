/**
 * session-dir-gc.test.ts — the per-session isolation-dir janitor (the EI-155
 * follow-on; source `session-dir-gc.ts`).
 *
 * Two layers:
 *   - the PURE planner / classifiers (no fs/PG, injected clock) — the keep vs
 *     collect decision + the protected-set + key matching;
 *   - the FS sweep against tmp roots with an injected protected set + clock,
 *     incl. the symlink-mirror safety invariant (rm unlinks links, never follows
 *     them into the real `~/.claude`).
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRetentionPin } from './storage/retention-pins';
import {
  DEFAULT_RETENTION_MS,
  defaultSessionDirRoots,
  discoverSessionDirCandidates,
  findUnarchivedSessionDirs,
  isProtected,
  planSessionDirGc,
  protectLivePtyHostHomes,
  runSessionDirGc,
  sessionDirKey,
  sweepStaleSessionDirs,
  type ProtectedSessionIdentity,
  type SessionDirCandidate,
  type SessionDirRoot,
} from './session-dir-gc';

const NOW = 1_780_000_000_000; // fixed injected clock (ms)
const empty: ProtectedSessionIdentity = { ownerIds: new Set(), sessionKeys: new Set() };

const cleanups: string[] = [];
afterEach(() => {
  for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'session-dir-gc-test-'));
  cleanups.push(d);
  return d;
}
/** A child dir under `root` with its mtime set `ageMs` in the past relative to NOW. */
function seedDir(root: string, name: string, ageMs: number): string {
  const p = join(root, name);
  mkdirSync(p, { recursive: true });
  const sec = (NOW - ageMs) / 1000;
  utimesSync(p, sec, sec);
  return p;
}

describe('session root caps', () => {
  it.each(['foreign ownership boundary', 'filesystem boundary'])('reports unknown cap usage for a %s', async (reason) => {
    const parent = tmpRoot(); const root = join(parent, 'homes'); mkdirSync(root);
    const census = await import('./storage/disk-consumer-census');
    const inspect = vi.spyOn(census, 'inspectRetentionTrees').mockResolvedValue({ entries: [],
      retained: [{ path: join(root, 'unknown'), reason }], inspectedNodes: 1, retainedRecentTrees: 0 });
    vi.stubEnv('PAPERCUSP_RELEASE_RETENTION_ROOT', join(parent, 'leases'));
    vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(parent, 'mutex'));
    try {
      const result = await runSessionDirGc({ roots: [{ root, keyKind: 'owner', label: 'fixture' }],
        protectedIdentity: empty, archiveGuard: false });
      expect(result.caps![0]).toMatchObject({ beforeBytes: null, afterBytes: null, pinnedBytes: null, overByBytes: null });
      expect(result.errors[0]!.error).toContain(reason);
      expect(inspect).toHaveBeenCalledWith(root, expect.objectContaining({ sudo: null }));
    } finally { inspect.mockRestore(); vi.unstubAllEnvs(); }
  });

  it('orders collectible directories by their last content write, preserving archive and pin guards', () => {
    const root = tmpRoot();
    const a = seedDir(root, 'a', DEFAULT_RETENTION_MS * 3);
    const z = seedDir(root, 'z', DEFAULT_RETENTION_MS * 2);
    const unarchived = seedDir(root, 'unarchived', DEFAULT_RETENTION_MS * 4);
    const result = sweepStaleSessionDirs({ roots: [{ root, keyKind: 'owner', label: 'fixture' }],
      protectedIdentity: empty, nowMs: NOW, retentionPins: [], unarchivedPaths: new Set([unarchived]),
      newestWrites: new Map([[a, 2], [z, 1]]) });
    expect(result.removed).toEqual([z, a]);
    expect(result.keptUnarchived).toBe(1);
    expect(existsSync(unarchived)).toBe(true);
  });

  it.each([false, true])('measures retained bytes and pinned overage without following mirrors (dryRun=%s)', async (dryRun) => {
    const parent = tmpRoot(); const root = join(parent, 'homes'); mkdirSync(root);
    const old = seedDir(root, 'old', DEFAULT_RETENTION_MS * 3);
    const pinned = seedDir(root, 'pinned', DEFAULT_RETENTION_MS * 3);
    const live = seedDir(root, 'live', DEFAULT_RETENTION_MS * 3);
    for (const path of [old, pinned, live]) {
      writeFileSync(join(path, 'data'), Buffer.alloc(64 * 1024));
      utimesSync(path, 1, 1);
    }
    const fresh = seedDir(root, 'fresh', 0); utimesSync(fresh, new Date(), new Date());
    const owner = join(parent, 'owner'); mkdirSync(owner); writeFileSync(join(owner, 'data'), Buffer.alloc(1024 * 1024));
    symlinkSync(owner, join(pinned, 'mirror'));
    utimesSync(pinned, 1, 1);
    const leases = join(parent, 'leases');
    createRetentionPin({ path: pinned, owner: 'fixture', reason: 'cap exemption',
      expiresAt: new Date(Date.now() + 60_000).toISOString() }, { dir: leases });
    vi.stubEnv('PAPERCUSP_RELEASE_RETENTION_ROOT', leases);
    vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(parent, 'mutex'));
    try {
      const result = await runSessionDirGc({ roots: [{ root, keyKind: 'owner', label: 'fixture', maxBytes: 1 }],
        protectedIdentity: { ownerIds: new Set(['live']), sessionKeys: new Set() }, archiveGuard: false, dryRun });
      expect(result.errors).toEqual([]);
      expect(result.removed).toEqual([old]);
      expect(existsSync(old)).toBe(dryRun);
      for (const path of [pinned, live, fresh, join(owner, 'data')]) expect(existsSync(path)).toBe(true);
      const cap = result.caps![0]!;
      expect(cap.beforeBytes).toBeGreaterThanOrEqual(3 * 64 * 1024);
      expect(cap.afterBytes).toBeGreaterThanOrEqual(2 * 64 * 1024);
      expect(cap.afterBytes).toBeLessThan(1024 * 1024);
      expect(cap.pinnedBytes).toBeGreaterThanOrEqual(64 * 1024);
      expect(cap.overByBytes).toBe(cap.afterBytes! - 1);
      if (dryRun) expect(cap.afterBytes).toBe(cap.beforeBytes);
      else expect(cap.afterBytes).toBeLessThan(cap.beforeBytes!);
    } finally { vi.unstubAllEnvs(); }
  });
});

describe('sessionDirKey', () => {
  it('a retention pin protects an expired session directory until expiry', () => {
    const root = tmpRoot();
    const path = seedDir(root, 'su-review', DEFAULT_RETENTION_MS + 1000);
    const pin = createRetentionPin({ path, owner: 'reviewer', reason: 'retain session',
      expiresAt: new Date(NOW + 1000).toISOString() }, { nowMs: NOW, dir: join(root, 'leases') });
    const candidates: SessionDirCandidate[] = [{ path, key: 'su-review', keyKind: 'owner', mtimeMs: NOW - DEFAULT_RETENTION_MS - 1000 }];
    const kept = sweepStaleSessionDirs({ protectedIdentity: empty, candidates, nowMs: NOW, retentionPins: [pin] });
    expect(kept.removed).toEqual([]);
    expect(kept.keptProtected).toBe(1);
    expect(existsSync(path)).toBe(true);
    const expired = sweepStaleSessionDirs({ protectedIdentity: empty, candidates, nowMs: NOW + 1000, retentionPins: [pin] });
    expect(expired.removed).toEqual([path]);
    expect(existsSync(path)).toBe(false);
  });

  it('owner roots use the name verbatim; session roots strip the session- prefix', () => {
    expect(sessionDirKey('su-1c079ae0-b17d', 'owner')).toBe('su-1c079ae0-b17d');
    expect(sessionDirKey('s-1780813923126-d6fffc0a', 'owner')).toBe('s-1780813923126-d6fffc0a');
    expect(sessionDirKey('session-637', 'session')).toBe('637');
    // defensive: a session root dir without the prefix → used whole
    expect(sessionDirKey('weird', 'session')).toBe('weird');
  });
});

describe('isProtected', () => {
  const prot: ProtectedSessionIdentity = {
    ownerIds: new Set(['su-alive']),
    sessionKeys: new Set(['637']),
  };
  it('matches owner-keyed dirs against ownerIds', () => {
    expect(isProtected({ keyKind: 'owner', key: 'su-alive' }, prot)).toBe(true);
    expect(isProtected({ keyKind: 'owner', key: 'su-dead' }, prot)).toBe(false);
  });
  it('matches session-keyed dirs against sessionKeys (never cross-matches owners)', () => {
    expect(isProtected({ keyKind: 'session', key: '637' }, prot)).toBe(true);
    expect(isProtected({ keyKind: 'session', key: '999' }, prot)).toBe(false);
    // an owner id is never a session key and vice-versa
    expect(isProtected({ keyKind: 'session', key: 'su-alive' }, prot)).toBe(false);
  });
});

describe('planSessionDirGc', () => {
  const mk = (key: string, keyKind: 'owner' | 'session', ageMs: number): SessionDirCandidate => ({
    path: `/fake/${keyKind}/${key}`,
    keyKind,
    key,
    mtimeMs: NOW - ageMs,
  });
  const RET = DEFAULT_RETENTION_MS;

  it('keeps a live PTY host home even when its adv row and coord presence are gone', () => {
    const protectedIdentity = protectLivePtyHostHomes(
      { ownerIds: new Set(), sessionKeys: new Set() },
      [{ ownerId: 'su-live-pty', advSessionId: '23321' }],
    );
    const plan = planSessionDirGc({
      candidates: [
        mk('su-live-pty', 'owner', RET * 3),
        mk('23321', 'session', RET * 3),
      ],
      protectedIdentity,
      nowMs: NOW,
      retentionMs: RET,
    });
    expect(plan.keptProtected.map((c) => c.key).sort()).toEqual(['23321', 'su-live-pty']);
    expect(plan.remove).toEqual([]);
  });

  it('keeps protected dirs regardless of age', () => {
    const prot: ProtectedSessionIdentity = { ownerIds: new Set(['su-live']), sessionKeys: new Set() };
    const plan = planSessionDirGc({
      candidates: [mk('su-live', 'owner', RET * 100)], // ancient but live
      protectedIdentity: prot,
      nowMs: NOW,
      retentionMs: RET,
    });
    expect(plan.keptProtected.map((c) => c.key)).toEqual(['su-live']);
    expect(plan.remove).toEqual([]);
  });

  it('keeps a fresh unprotected dir, removes a stale one', () => {
    const plan = planSessionDirGc({
      candidates: [
        mk('su-fresh', 'owner', RET / 2), // within retention → kept
        mk('su-stale', 'owner', RET * 2), // past retention, not protected → removed
        mk('637', 'session', RET * 3), // stale codex home → removed
      ],
      protectedIdentity: empty,
      nowMs: NOW,
      retentionMs: RET,
    });
    expect(plan.keptFresh.map((c) => c.key)).toEqual(['su-fresh']);
    expect(plan.remove.map((c) => c.key).sort()).toEqual(['637', 'su-stale']);
  });

  it('collects at the retention boundary (age >= retention), keeps just under it', () => {
    const plan = planSessionDirGc({
      candidates: [
        mk('su-under', 'owner', RET - 1), // just inside the window → kept
        mk('su-edge', 'owner', RET), // age === retention → collectible
      ],
      protectedIdentity: empty,
      nowMs: NOW,
      retentionMs: RET,
    });
    expect(plan.keptFresh.map((c) => c.key)).toEqual(['su-under']);
    expect(plan.remove.map((c) => c.key)).toEqual(['su-edge']);
  });
});

describe('planSessionDirGc archive guard', () => {
  const mk = (key: string, ageMs: number): SessionDirCandidate => ({
    path: `/tmp/${key}`,
    keyKind: 'owner',
    key,
    mtimeMs: NOW - ageMs,
  });

  it('OWNERSHIP (WI-6554700010010238): never collects a dir another install materialized, even past retention', () => {
    const mine = mk('su-mine', DEFAULT_RETENTION_MS * 2);
    const foreign = mk('su-foreign', DEFAULT_RETENTION_MS * 2);
    const plan = planSessionDirGc({
      candidates: [mine, foreign],
      protectedIdentity: { ...empty, owned: { ownerIds: new Set(['su-mine']), sessionKeys: new Set() } },
      nowMs: NOW,
      retentionMs: DEFAULT_RETENTION_MS,
      unarchivedPaths: new Set(),
    });
    expect(plan.remove).toEqual([mine]);
    expect(plan.keptForeign).toEqual([foreign]);
  });

  it('diverts a stale-but-unarchived dir to keptUnarchived instead of remove', () => {
    const archived = mk('su-archived', DEFAULT_RETENTION_MS * 2);
    const notYet = mk('su-not-yet', DEFAULT_RETENTION_MS * 2);
    const plan = planSessionDirGc({
      candidates: [archived, notYet],
      protectedIdentity: empty,
      nowMs: NOW,
      retentionMs: DEFAULT_RETENTION_MS,
      unarchivedPaths: new Set([notYet.path]),
    });
    expect(plan.remove).toEqual([archived]);
    expect(plan.keptUnarchived).toEqual([notYet]);
  });

  it('protection outranks the guard, and omitting the guard restores legacy removal', () => {
    const stale = mk('su-stale', DEFAULT_RETENTION_MS * 2);
    // no unarchivedPaths ⇒ legacy (lossy) mode: retention alone decides
    const legacy = planSessionDirGc({
      candidates: [stale],
      protectedIdentity: empty,
      nowMs: NOW,
      retentionMs: DEFAULT_RETENTION_MS,
    });
    expect(legacy.remove).toEqual([stale]);
    expect(legacy.keptUnarchived).toEqual([]);

    // a protected dir is never collected, guard or no guard
    const prot: ProtectedSessionIdentity = { ownerIds: new Set(['su-stale']), sessionKeys: new Set() };
    const guarded = planSessionDirGc({
      candidates: [stale],
      protectedIdentity: prot,
      nowMs: NOW,
      retentionMs: DEFAULT_RETENTION_MS,
      unarchivedPaths: new Set([stale.path]),
    });
    expect(guarded.keptProtected).toEqual([stale]);
    expect(guarded.remove).toEqual([]);
  });
});

describe('degraded protected-set', () => {
  // The protected-set reads fail OPEN (a dead PG yields no protected ids), so a
  // sweep that trusted it would delete live sessions' homes — including BARE
  // dirs (mid-launch, no jsonl yet) that the archive guard cannot shield.
  it('runSessionDirGc ABORTS the sweep rather than trust an incomplete set', async () => {
    // A real dir that a naive sweep would collect (stale, unprotected).
    const root = tmpRoot();
    const stale = seedDir(root, 'su-live-but-unknown', DEFAULT_RETENTION_MS * 2);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await runSessionDirGc({
        protectedIdentity: { ownerIds: new Set(), sessionKeys: new Set(), degraded: true },
      });
      expect(res.skipped).toBe('degraded-protected-set');
      expect(res.removed).toEqual([]);
      expect(res.scanned).toBe(0); // aborted before even scanning
      expect(existsSync(stale)).toBe(true); // the live-but-unknown home survives
    } finally {
      warn.mockRestore();
    }
  });

  it('a healthy (non-degraded) set sweeps normally', () => {
    const stale: SessionDirCandidate = {
      path: '/tmp/su-dead',
      keyKind: 'owner',
      key: 'su-dead',
      mtimeMs: NOW - DEFAULT_RETENTION_MS * 2,
    };
    const healthy: ProtectedSessionIdentity = { ownerIds: new Set(), sessionKeys: new Set() };
    const plan = planSessionDirGc({
      candidates: [stale],
      protectedIdentity: healthy,
      nowMs: NOW,
      retentionMs: DEFAULT_RETENTION_MS,
    });
    expect(plan.remove).toEqual([stale]);
  });
});

describe('findUnarchivedSessionDirs', () => {
  /** A claude-shaped dir with one session jsonl under projects/<slug>/. */
  function seedClaudeSession(root: string, name: string, sessionId: string): string {
    const p = join(root, name, 'projects', '-home-x');
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, `${sessionId}.jsonl`), '{}\n');
    return join(root, name);
  }

  it('blocks a dir with an un-stamped session, clears one whose stamp is committed', async () => {
    const root = tmpRoot();
    const committed = seedClaudeSession(root, 'su-committed', 'aaaaaaaa-0000-4000-8000-000000000001');
    const missing = seedClaudeSession(root, 'su-missing', 'bbbbbbbb-0000-4000-8000-000000000002');
    const store = {
      readStamp: async (_kind: string, id: string) =>
        id.startsWith('aaaaaaaa') ? { session_id: id } : null,
    };
    const candidates = discoverSessionDirCandidates([
      { root, keyKind: 'owner', label: 'session-claude' },
    ]);
    const blocked = await findUnarchivedSessionDirs(candidates, { store });

    expect(blocked.has(missing)).toBe(true);
    expect(blocked.has(committed)).toBe(false);
  });

  it('FAILS CLOSED: a stamp read that throws keeps the dir (never risks deletion)', async () => {
    const root = tmpRoot();
    const dir = seedClaudeSession(root, 'su-unreadable', 'cccccccc-0000-4000-8000-000000000003');
    const store = {
      readStamp: async () => {
        throw new Error('pg down');
      },
    };
    const candidates = discoverSessionDirCandidates([
      { root, keyKind: 'owner', label: 'session-claude' },
    ]);
    // the guard warns loudly on a failed read (by design) — assert it, and keep
    // vitest-fail-on-console happy.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const blocked = await findUnarchivedSessionDirs(candidates, { store });
      expect(blocked.has(dir)).toBe(true);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it('a dir with no session files is safe to collect (nothing to lose)', async () => {
    const root = tmpRoot();
    const bare = seedDir(root, 'su-bare', DEFAULT_RETENTION_MS * 2);
    const store = { readStamp: async () => null };
    const candidates = discoverSessionDirCandidates([
      { root, keyKind: 'owner', label: 'session-claude' },
    ]);
    const blocked = await findUnarchivedSessionDirs(candidates, { store });
    expect(blocked.has(bare)).toBe(false);
  });
});

describe('discoverSessionDirCandidates', () => {
  it('finds child dirs with mtimes, skips files, and skips absent roots', () => {
    const claude = tmpRoot();
    seedDir(claude, 'su-aaa', 1000);
    seedDir(claude, 'su-bbb', 2000);
    writeFileSync(join(claude, 'stray-file'), 'x'); // a file, not a session dir

    const roots: SessionDirRoot[] = [
      { root: claude, keyKind: 'owner', label: 'claude' },
      { root: join(claude, 'does-not-exist'), keyKind: 'session', label: 'absent' },
    ];
    const cands = discoverSessionDirCandidates(roots);
    expect(cands.map((c) => c.key).sort()).toEqual(['su-aaa', 'su-bbb']);
    expect(cands.every((c) => c.keyKind === 'owner' && typeof c.mtimeMs === 'number')).toBe(true);
  });
});

describe('defaultSessionDirRoots', () => {
  it('sweeps the fast Codex SQLite companion with the same session-key protection as CODEX_HOME', () => {
    const prior = process.env.PAPERCUSP_CODEX_SQLITE_HOMES_DIR;
    const root = join(tmpRoot(), 'codex-sqlite-homes');
    process.env.PAPERCUSP_CODEX_SQLITE_HOMES_DIR = root;
    try {
      expect(defaultSessionDirRoots()).toContainEqual({
        root,
        keyKind: 'session',
        label: 'codex-sqlite-homes',
      });
    } finally {
      if (prior === undefined) delete process.env.PAPERCUSP_CODEX_SQLITE_HOMES_DIR;
      else process.env.PAPERCUSP_CODEX_SQLITE_HOMES_DIR = prior;
    }
  });
});

describe('sweepStaleSessionDirs', () => {
  function setup() {
    const claude = tmpRoot();
    const codex = tmpRoot();
    const live = seedDir(claude, 'su-live', DEFAULT_RETENTION_MS * 5); // ancient but protected
    const fresh = seedDir(claude, 'su-fresh', 1000); // within retention
    const stale = seedDir(claude, 'su-stale', DEFAULT_RETENTION_MS * 2); // collectible
    const codexOpen = seedDir(codex, 'session-700', DEFAULT_RETENTION_MS * 2); // protected key
    const codexStale = seedDir(codex, 'session-42', DEFAULT_RETENTION_MS * 2); // collectible
    const roots: SessionDirRoot[] = [
      { root: claude, keyKind: 'owner', label: 'session-claude' },
      { root: codex, keyKind: 'session', label: 'su-codex-homes' },
    ];
    const prot: ProtectedSessionIdentity = {
      ownerIds: new Set(['su-live']),
      sessionKeys: new Set(['700']),
    };
    return { roots, prot, live, fresh, stale, codexOpen, codexStale };
  }

  it('removes only stale unprotected dirs; keeps live + fresh + protected-key', () => {
    const { roots, prot, live, fresh, stale, codexOpen, codexStale } = setup();
    const res = sweepStaleSessionDirs({ protectedIdentity: prot, roots, nowMs: NOW });

    expect(res.removed.sort()).toEqual([stale, codexStale].sort());
    expect(res.keptProtected).toBe(2); // su-live + session-700
    expect(res.keptFresh).toBe(1); // su-fresh
    expect(res.errors).toEqual([]);

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(codexStale)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(codexOpen)).toBe(true);
  });

  it('dryRun plans the same removals but deletes nothing', () => {
    const { roots, prot, stale, codexStale } = setup();
    const res = sweepStaleSessionDirs({ protectedIdentity: prot, roots, nowMs: NOW, dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.removed.sort()).toEqual([stale, codexStale].sort());
    expect(existsSync(stale)).toBe(true); // not actually removed
    expect(existsSync(codexStale)).toBe(true);
  });

  // The 24h retention is a materialization-race guard, NOT the safety net — the
  // archive is. A stale dir whose sessions are not yet committed to
  // session_archives must SURVIVE the sweep, or archive-at-death silently
  // becomes delete-at-death for every session the archiver missed.
  it('SAFETY: never deletes a stale dir whose sessions are not yet archived', () => {
    const { roots, prot, stale, codexStale } = setup();
    const res = sweepStaleSessionDirs({
      protectedIdentity: prot,
      roots,
      nowMs: NOW,
      unarchivedPaths: new Set([stale]), // archiver has not committed this one
    });

    expect(res.removed).toEqual([codexStale]); // only the archived one goes
    expect(res.keptUnarchived).toBe(1);
    expect(existsSync(stale)).toBe(true); // withheld — data preserved
    expect(existsSync(codexStale)).toBe(false);
  });

  it('SAFETY: removing a symlink-mirror dir unlinks the links, never the real targets', () => {
    // A real "~/.claude" the session-claude dir mirrors.
    const realClaude = tmpRoot();
    const realCreds = join(realClaude, '.credentials.json');
    const realPlugins = join(realClaude, 'plugins');
    writeFileSync(realCreds, 'SECRET-OAUTH');
    mkdirSync(realPlugins, { recursive: true });
    writeFileSync(join(realPlugins, 'skill.txt'), 'a skill');

    // A stale session-claude dir: symlinks back to the real entries + a real
    // isolated projects/ holding this session's transcript.
    const claudeRoot = tmpRoot();
    const sessionDir = seedDir(claudeRoot, 'su-stale', DEFAULT_RETENTION_MS * 2);
    symlinkSync(realCreds, join(sessionDir, '.credentials.json'));
    symlinkSync(realPlugins, join(sessionDir, 'plugins'));
    const projects = join(sessionDir, 'projects', 'slug');
    mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, 'transcript.jsonl'), '{"line":1}');
    // re-stamp the (now mutated) dir mtime back into the past so it's collectible
    const past = (NOW - DEFAULT_RETENTION_MS * 2) / 1000;
    utimesSync(sessionDir, past, past);

    const res = sweepStaleSessionDirs({
      protectedIdentity: empty,
      roots: [{ root: claudeRoot, keyKind: 'owner', label: 'session-claude' }],
      nowMs: NOW,
    });

    expect(res.removed).toEqual([sessionDir]);
    expect(existsSync(sessionDir)).toBe(false); // the session dir (+ its links + projects/) gone
    // the REAL targets the symlinks pointed at survive untouched
    expect(existsSync(realCreds)).toBe(true);
    expect(readFileSync(realCreds, 'utf8')).toBe('SECRET-OAUTH');
    expect(existsSync(join(realPlugins, 'skill.txt'))).toBe(true);
    expect(lstatSync(realPlugins).isDirectory()).toBe(true);
  });
});
