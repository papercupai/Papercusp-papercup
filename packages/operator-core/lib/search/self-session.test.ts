import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSelfSession, resolveOwnerIsolatedSessionByPrefix } from './self-session';

const SID = '019f4fa9-4a09-78c0-8a35-d7e3382d1f8f';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('resolveSelfSession — launcher executable paths', () => {
  it.each(['codex', '/home/testuser/.local/node25/bin/codex'])(
    'finds the managed Codex transcript when discovery names %s',
    async (command) => {
      const home = await mkdtemp(join(tmpdir(), 'self-session-'));
      roots.push(home);
      const ptyDir = join(home, '.papercusp', 'psu-pty');
      const rolloutDir = join(home, '.papercusp', 'su-codex-homes', 'session-11801', 'sessions');
      await mkdir(ptyDir, { recursive: true });
      await mkdir(rolloutDir, { recursive: true });
      await writeFile(join(ptyDir, 'su-current.json'), JSON.stringify({ command, args: [] }));
      const filePath = join(rolloutDir, `rollout-2026-10-07T21-05-19-${SID}.jsonl`);
      await writeFile(filePath, '{}\n');

      const resolved = await resolveSelfSession('su-current', {
        home,
        loadActiveSessions: async () => [{ id: 11801, agent: 'codex', session_id: SID, omp_thread_id: null }],
      });

      expect(resolved).toEqual({ sourceKind: 'codex', sessionId: SID, filePath });
    },
  );

  it.each(['omp', '/home/testuser/.local/bin/omp'])(
    'finds the pinned OMP transcript when discovery names %s',
    async (command) => {
      const home = await mkdtemp(join(tmpdir(), 'self-session-'));
      roots.push(home);
      const ptyDir = join(home, '.papercusp', 'psu-pty');
      const sessionDir = join(home, '.omp', 'agent', 'sessions', 'workspace');
      await mkdir(ptyDir, { recursive: true });
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(ptyDir, 'su-current.json'), JSON.stringify({ command, args: ['--resume', SID] }));
      const filePath = join(sessionDir, `2026-10-07_${SID}.jsonl`);
      await writeFile(filePath, '{}\n');

      const resolved = await resolveSelfSession('su-current', { home, loadActiveSessions: async () => [] });

      expect(resolved).toEqual({ sourceKind: 'omp', sessionId: SID, filePath });
    },
  );
});

describe('resolveSelfSession — fresh Codex without a rollout', () => {
  it('uses the active adv-session to find the isolated history fallback', async () => {
    const home = await mkdtemp(join(tmpdir(), 'self-session-'));
    roots.push(home);
    const codexHome = join(home, '.papercusp', 'su-codex-homes', 'session-11801');
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      join(codexHome, 'history.jsonl'),
      `${JSON.stringify({ session_id: SID, ts: 1_783_926_209, text: 'audit this session' })}\n`,
    );

    const resolved = await resolveSelfSession('su-current', {
      home,
      loadActiveSessions: async () => [{
        id: 11801,
        agent: 'codex',
        session_id: null,
        omp_thread_id: null,
      }],
    });

    expect(resolved).toEqual({
      sourceKind: 'codex',
      sessionId: SID,
      filePath: join(codexHome, 'history.jsonl'),
    });
  });
});

describe('resolveSelfSession — Codex cold-carry respawn chain', () => {
  const STALE = '019f4fa9-4a09-78c0-8a35-d7e3382d1f8f';
  const CURRENT = '119f4fa9-4a09-78c0-8a35-d7e3382d1f8f';

  it('resolves the newest managed rollout instead of the stale adv-session id', async () => {
    const home = await mkdtemp(join(tmpdir(), 'self-session-'));
    roots.push(home);
    const codexHome = join(home, '.papercusp', 'su-codex-homes', 'session-11801');
    const rolloutDir = join(codexHome, 'sessions', '2026', '08', '23');
    await mkdir(rolloutDir, { recursive: true });
    const stalePath = join(rolloutDir, `rollout-2026-08-23T07-00-00-${STALE}.jsonl`);
    const currentPath = join(rolloutDir, `rollout-2026-08-23T08-00-00-${CURRENT}.jsonl`);
    await writeFile(stalePath, '{}\n');
    await writeFile(currentPath, '{}\n');
    await utimes(stalePath, new Date(1_600_000_000_000), new Date(1_600_000_000_000));
    await utimes(currentPath, new Date(1_600_000_600_000), new Date(1_600_000_600_000));

    const resolved = await resolveSelfSession('su-current', {
      home,
      loadActiveSessions: async () => [{
        id: 11801,
        agent: 'codex',
        session_id: STALE,
        omp_thread_id: null,
      }],
    });

    expect(resolved).toEqual({ sourceKind: 'codex', sessionId: CURRENT, filePath: currentPath });
  });

  it('resolves a managed Codex rollout by native session prefix for carry provenance', async () => {
    const home = await mkdtemp(join(tmpdir(), 'self-session-'));
    roots.push(home);
    const codexHome = join(home, '.papercusp', 'su-codex-homes', 'session-11801');
    const rolloutDir = join(codexHome, 'sessions', '2026', '08', '25');
    await mkdir(rolloutDir, { recursive: true });
    const rolloutPath = join(rolloutDir, `rollout-2026-08-25T03-24-24-${CURRENT}.jsonl`);
    await writeFile(rolloutPath, '{}\n');

    const resolved = await resolveOwnerIsolatedSessionByPrefix('su-current', CURRENT.slice(0, 8), {
      home,
      loadActiveSessions: async () => [{
        id: 11801,
        agent: 'codex',
        session_id: CURRENT,
        omp_thread_id: null,
      }],
    });

    expect(resolved).toEqual({ sourceKind: 'codex', sessionId: CURRENT, filePath: rolloutPath });
  });

  it('resolves a successor rollout from an ended predecessor adv-session row', async () => {
    const home = await mkdtemp(join(tmpdir(), 'self-session-'));
    roots.push(home);
    const successorHome = join(home, '.papercusp', 'su-codex-homes', 'session-18680');
    const rolloutDir = join(successorHome, 'sessions', '2026', '08', '26');
    await mkdir(rolloutDir, { recursive: true });
    const rolloutPath = join(rolloutDir, `rollout-2026-08-26T09-46-47-${CURRENT}.jsonl`);
    await writeFile(rolloutPath, '{}\n');

    const resolved = await resolveOwnerIsolatedSessionByPrefix('su-current', CURRENT.slice(0, 8), {
      home,
      loadActiveSessions: async () => [{
        id: 11801,
        agent: 'codex',
        session_id: STALE,
        omp_thread_id: null,
      }],
      loadOwnerSessions: async () => [{
        id: 18680,
        agent: 'codex',
        session_id: CURRENT,
        omp_thread_id: null,
      }],
    });

    expect(resolved).toEqual({ sourceKind: 'codex', sessionId: CURRENT, filePath: rolloutPath });
  });
});

describe('resolveSelfSession — claude cold-carry respawn chain (WI-5644)', () => {
  const ORIGINAL = '0a52099c-de9f-43d4-ae49-8e72ca176ee8'; // frozen in the discovery record at first launch
  const CURRENT = 'c95d04fe-a291-4879-b93f-b49f9fb75144'; // newest transcript, minted by a later carry-respawn

  async function seedIsolationDir(home: string, owner: string, sessions: Array<{ id: string; mtime: number }>) {
    const proj = join(home, '.papercusp', 'session-claude', owner, 'projects', '-home-testuser-proj');
    await mkdir(proj, { recursive: true });
    for (const s of sessions) {
      const p = join(proj, `${s.id}.jsonl`);
      await writeFile(p, '{}\n');
      await utimes(p, new Date(s.mtime), new Date(s.mtime));
    }
    return proj;
  }

  async function seedDiscoveryRecord(home: string, owner: string, pinnedUuid: string) {
    const ptyDir = join(home, '.papercusp', 'psu-pty');
    await mkdir(ptyDir, { recursive: true });
    // A cold carry-respawn NEVER rewrites the discovery `args`, so `--session-id`
    // stays frozen at the ORIGINAL launch id — the exact staleness of WI-5644.
    await writeFile(
      join(ptyDir, `${owner}.json`),
      JSON.stringify({ command: 'claude', args: ['--session-id', pinnedUuid] }),
    );
  }

  it('resolves to the NEWEST isolation-dir transcript, ignoring the stale pinned --session-id', async () => {
    const home = await mkdtemp(join(tmpdir(), 'self-session-'));
    roots.push(home);
    const owner = 'su-cold-carry';
    const proj = await seedIsolationDir(home, owner, [
      { id: ORIGINAL, mtime: 1_600_000_000_000 }, // original, oldest
      { id: CURRENT, mtime: 1_600_000_600_000 }, // current live, newest
    ]);
    await seedDiscoveryRecord(home, owner, ORIGINAL);

    const resolved = await resolveSelfSession(owner, { home, loadActiveSessions: async () => [] });

    // Pre-fix this returned ORIGINAL (the stale pin) → self-recall missed all
    // post-respawn history. It must resolve to the CURRENT live transcript.
    expect(resolved).toEqual({ sourceKind: 'claude', sessionId: CURRENT, filePath: join(proj, `${CURRENT}.jsonl`) });
  });

  it('falls back to the newest transcript when the pinned session file was archive-reaped (never null)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'self-session-'));
    roots.push(home);
    const owner = 'su-reaped';
    // The pinned ORIGINAL .jsonl is GONE (session-archive-hook deleted it ~15s
    // after that wake ended); only the current transcript survives on disk.
    const proj = await seedIsolationDir(home, owner, [{ id: CURRENT, mtime: 1_600_000_600_000 }]);
    await seedDiscoveryRecord(home, owner, ORIGINAL);

    const resolved = await resolveSelfSession(owner, { home, loadActiveSessions: async () => [] });

    // Pre-fix this returned null → the "could not be pinned to a live transcript"
    // degrade. It must now resolve to the surviving current transcript.
    expect(resolved).toEqual({ sourceKind: 'claude', sessionId: CURRENT, filePath: join(proj, `${CURRENT}.jsonl`) });
  });

  // EI-19297300002186512: resolveSelfSession only ever returns the newest
  // transcript — resolveOwnerIsolatedSessionByPrefix is what lets a
  // [turn:…] ref anchored to an OLDER session in the same owner's chain
  // resolve at all.
  describe('resolveOwnerIsolatedSessionByPrefix (EI-19297300002186512)', () => {
    it('finds an OLDER session in the same owner isolation dir by id prefix', async () => {
      const home = await mkdtemp(join(tmpdir(), 'self-session-'));
      roots.push(home);
      const owner = 'su-carry-chain';
      const proj = await seedIsolationDir(home, owner, [
        { id: ORIGINAL, mtime: 1_600_000_000_000 },
        { id: CURRENT, mtime: 1_600_000_600_000 },
      ]);

      const resolved = await resolveOwnerIsolatedSessionByPrefix(owner, ORIGINAL.slice(0, 8), { home });

      expect(resolved).toEqual({ sourceKind: 'claude', sessionId: ORIGINAL, filePath: join(proj, `${ORIGINAL}.jsonl`) });
    });

    it('returns null for a prefix with no matching session in this owner chain', async () => {
      const home = await mkdtemp(join(tmpdir(), 'self-session-'));
      roots.push(home);
      const owner = 'su-carry-chain-2';
      await seedIsolationDir(home, owner, [{ id: CURRENT, mtime: 1_600_000_600_000 }]);

      const resolved = await resolveOwnerIsolatedSessionByPrefix(owner, 'deadbeef', { home });

      expect(resolved).toBeNull();
    });

    it('never crosses owners — a matching prefix under a DIFFERENT owner dir is invisible', async () => {
      const home = await mkdtemp(join(tmpdir(), 'self-session-'));
      roots.push(home);
      // The session lives under a different owner's isolation dir.
      await seedIsolationDir(home, 'su-owner-a', [{ id: ORIGINAL, mtime: 1_600_000_000_000 }]);

      const resolved = await resolveOwnerIsolatedSessionByPrefix('su-owner-b', ORIGINAL.slice(0, 8), { home });

      expect(resolved).toBeNull();
    });
  });
});

describe('resolveSelfSession — coord-id drift across a carry-respawn (WI-5681)', () => {
  const CURRENT_TXN = 'cdeb9be0-0e7d-40db-bd29-7426f2d19b36'; // live transcript basename

  it('bridges to the isolation dir via the live process CLAUDE_CONFIG_DIR when the coord id drifted', async () => {
    const home = await mkdtemp(join(tmpdir(), 'self-session-'));
    roots.push(home);
    const coordId = 'su-current-coord'; // what coord:whoami returns NOW
    const launchId = 'su-launch-time-iso'; // the id that NAMES the isolation dir (frozen at launch)
    // The transcript lives under the LAUNCH-time id's isolation dir, NOT the coord id's.
    const proj = join(home, '.papercusp', 'session-claude', launchId, 'projects', '-home-testuser-proj');
    await mkdir(proj, { recursive: true });
    const txnPath = join(proj, `${CURRENT_TXN}.jsonl`);
    await writeFile(txnPath, '{}\n');
    // The discovery record is keyed by the CURRENT coord id and carries the live pids.
    const ptyDir = join(home, '.papercusp', 'psu-pty');
    await mkdir(ptyDir, { recursive: true });
    await writeFile(
      join(ptyDir, `${coordId}.json`),
      JSON.stringify({ command: 'claude', pid: 111, ptyPid: 222, args: [] }),
    );

    const isoConfigDir = join(home, '.papercusp', 'session-claude', launchId);
    const resolved = await resolveSelfSession(coordId, {
      home,
      loadActiveSessions: async () => [],
      // What /proc/<ptyPid>/environ carries: the live CLI's real CLAUDE_CONFIG_DIR.
      readProcEnviron: async (pid) => (pid === 222 ? { CLAUDE_CONFIG_DIR: isoConfigDir } : null),
    });

    // Pre-fix: the coord-id dir is empty and no uuid pins it → null (the 0-hit
    // "could not be pinned" degrade). It must bridge via the live process env.
    expect(resolved).toEqual({ sourceKind: 'claude', sessionId: CURRENT_TXN, filePath: txnPath });
  });

  it('never cross-contaminates: ignores a CLAUDE_CONFIG_DIR outside a session-claude root', async () => {
    const home = await mkdtemp(join(tmpdir(), 'self-session-'));
    roots.push(home);
    const coordId = 'su-current-coord';
    // A shared ~/.claude config dir holds OTHER owners' sessions — never trust it
    // for the drift bridge.
    const sharedDir = join(home, '.claude');
    await mkdir(join(sharedDir, 'projects', '-home-x'), { recursive: true });
    await writeFile(join(sharedDir, 'projects', '-home-x', 'peer.jsonl'), '{}\n');
    const ptyDir = join(home, '.papercusp', 'psu-pty');
    await mkdir(ptyDir, { recursive: true });
    await writeFile(
      join(ptyDir, `${coordId}.json`),
      JSON.stringify({ command: 'claude', pid: 111, ptyPid: 222, args: [] }),
    );

    const resolved = await resolveSelfSession(coordId, {
      home,
      loadActiveSessions: async () => [],
      readProcEnviron: async () => ({ CLAUDE_CONFIG_DIR: sharedDir }),
    });
    expect(resolved).toBeNull();
  });
});
