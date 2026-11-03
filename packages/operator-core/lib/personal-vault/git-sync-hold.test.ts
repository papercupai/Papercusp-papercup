/**
 * Plan personal-data-reader-set-labels-2026-10-01 P-014 (WI-10005571), BAR R-10:
 * a path a session edited while it held an active disclosure is excluded from
 * git-sync's staging pathspecs until that disclosure is released.
 *
 * The SQL predicate itself runs against real Postgres in
 * git-sync-hold.integration.test.ts; this file pins the mapping, the fail-closed
 * contract, and the end-to-end effect on a real git repository via runGitSync.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  GIT_SYNC_CENSUS_LEGS,
  RESTRICTED_HOLD_INTENT,
  RESTRICTED_WINDOW_INTENT,
  RESTRICTED_WINDOW_OWNER,
  TURN_HOLD_INTENT,
  TURN_HOLD_MAX_AGE_MS,
  isCensusHoldIntent,
  isRestrictedHoldIntent,
  isTurnHoldIntent,
  listDirtyFilesRecursive,
  ownerHasActiveDisclosure,
  readGitSyncCensusStrict,
  readRestrictedEditHoldings,
  readRestrictedSourceHoldState,
  readRestrictedWindowHoldings,
  readTurnHoldings,
  recordRestrictedEditBeforeRelease,
  restrictedHoldingsFromRows,
  turnHoldingsFromRows,
  type HoldRunGit,
  type RestrictedEditRow,
} from './git-sync-hold';

const execFileAsync = promisify(execFile);
import { DisclosureRefused } from './disclosure-ledger';
import { runGitSync } from '../harness/git-sync/run-git-sync';

type FakeSql = NonNullable<Parameters<typeof readRestrictedEditHoldings>[0]>;

/** A tagged-template fake that records the statement text and answers with `rows`. */
function fakeSql(answer: () => unknown[]): { sql: FakeSql; statements: string[] } {
  const statements: string[] = [];
  const fn = (strings: TemplateStringsArray) => {
    statements.push(strings.join('?'));
    return Promise.resolve().then(answer);
  };
  return { sql: fn as unknown as FakeSql, statements };
}

const ROW: RestrictedEditRow = {
  repo_root: '/srv/papercup-release',
  file: 'notes/secret.md',
  agent_id: 'su-restricted',
  work_item_id: 'WI-1',
};

describe('restrictedHoldingsFromRows', () => {
  it('maps a ledger row to a census holding in the lock domain it was edited under', () => {
    expect(restrictedHoldingsFromRows([ROW])).toEqual([
      {
        path: 'notes/secret.md',
        owner: 'su-restricted',
        intent: RESTRICTED_HOLD_INTENT,
        goalRef: 'WI-1',
        coordinationDomain: '/srv/papercup-release',
      },
    ]);
  });

  it('keeps one holding per (domain, path), and drops rows with no path or no editor', () => {
    const out = restrictedHoldingsFromRows([
      ROW,
      { ...ROW, agent_id: 'su-other' },
      { ...ROW, repo_root: '/srv/papercusp' },
      { ...ROW, file: '  ' },
      { ...ROW, file: 'x.md', agent_id: null },
    ]);
    expect(out.map((h) => [h.coordinationDomain, h.path])).toEqual([
      ['/srv/papercup-release', 'notes/secret.md'],
      ['/srv/papercusp', 'notes/secret.md'],
    ]);
  });

  it('omits goalRef and coordinationDomain when the ledger has none', () => {
    const [h] = restrictedHoldingsFromRows([{ ...ROW, repo_root: null, work_item_id: null }]);
    expect(h).toEqual({ path: 'notes/secret.md', owner: 'su-restricted', intent: RESTRICTED_HOLD_INTENT });
  });

  it('marks its own rows, and only its own rows, as restricted holds', () => {
    expect(isRestrictedHoldIntent(RESTRICTED_HOLD_INTENT)).toBe(true);
    expect(isRestrictedHoldIntent('PreToolUse:Edit')).toBe(false);
    expect(isRestrictedHoldIntent('editing now')).toBe(false);
    expect(isRestrictedHoldIntent(undefined)).toBe(false);
  });
});

describe('readRestrictedEditHoldings', () => {
  it('selects edits made at or after an UNRELEASED disclosure was delivered to the same agent', async () => {
    const { sql, statements } = fakeSql(() => [ROW]);
    await expect(readRestrictedEditHoldings(sql)).resolves.toHaveLength(1);
    const text = statements.join('\n').replace(/\s+/g, ' ');
    expect(text).toContain('FROM harness_shared.personal_disclosures d');
    expect(text).toContain('JOIN harness_shared.edit_attribution_ledger l');
    expect(text).toContain('l.agent_id = d.agent_owner_id');
    expect(text).toContain('l.ts >= d.delivered_at');
    expect(text).toContain('d.released_at IS NULL');
  });

  it('fails closed: an unreadable ledger is a disclosure_ledger_unavailable refusal, never an empty census', async () => {
    const { sql } = fakeSql(() => {
      throw new Error('connection refused');
    });
    const err = await readRestrictedEditHoldings(sql).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DisclosureRefused);
    expect((err as DisclosureRefused).code).toBe('disclosure_ledger_unavailable');
  });

  it('recovers a one-time ECONNREFUSED on the read-only census query', async () => {
    let calls = 0;
    const { sql } = fakeSql(() => {
      calls++;
      if (calls === 1) {
        throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6432'), { code: 'ECONNREFUSED' });
      }
      return [ROW];
    });

    await expect(readRestrictedEditHoldings(sql)).resolves.toHaveLength(1);
    expect(calls).toBe(2);
  });

  it('recovers a one-time CONNECT_TIMEOUT on the read-only census query', async () => {
    let calls = 0;
    const { sql } = fakeSql(() => {
      calls++;
      if (calls === 1) {
        throw Object.assign(new Error('write CONNECT_TIMEOUT localhost:32769'), { code: 'CONNECT_TIMEOUT' });
      }
      return [ROW];
    });

    await expect(readRestrictedEditHoldings(sql)).resolves.toHaveLength(1);
    expect(calls).toBe(2);
  });

  it('still fails closed after bounded ECONNREFUSED retries', async () => {
    let calls = 0;
    const { sql } = fakeSql(() => {
      calls++;
      throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6432'), { code: 'ECONNREFUSED' });
    });

    await expect(readRestrictedEditHoldings(sql)).rejects.toMatchObject({
      code: 'disclosure_ledger_unavailable',
    });
    expect(calls).toBe(3);
  });
});

// git-sync-turn-scoped-commit-hold-2026-10-11 P-002/P-005. The SQL's boundaries run
// against real Postgres in git-sync-turn-hold.integration.test.ts.
describe('turn-scoped hold', () => {
  it('maps a ledger row to a turn holding in the lock domain it was edited under', () => {
    expect(turnHoldingsFromRows([{ ...ROW, ts: '2026-10-11T03:00:00Z' }])).toEqual([
      {
        path: 'notes/secret.md',
        owner: 'su-restricted',
        intent: TURN_HOLD_INTENT,
        goalRef: 'WI-1',
        coordinationDomain: '/srv/papercup-release',
        heldSince: '2026-10-11T03:00:00.000Z',
      },
    ]);
  });

  it('omits heldSince when the edit time is absent or unparseable', () => {
    const [noTs] = turnHoldingsFromRows([{ ...ROW, ts: null }]);
    const [badTs] = turnHoldingsFromRows([{ ...ROW, ts: 'not a time' }]);
    expect(noTs).not.toHaveProperty('heldSince');
    expect(badTs).not.toHaveProperty('heldSince');
  });

  it('is a census hold but not a restricted hold, so git-sync does not tell its holder to locks:release', () => {
    expect(isTurnHoldIntent(TURN_HOLD_INTENT)).toBe(true);
    expect(isRestrictedHoldIntent(TURN_HOLD_INTENT)).toBe(false);
    expect(isCensusHoldIntent(TURN_HOLD_INTENT)).toBe(true);
    expect(isCensusHoldIntent(RESTRICTED_HOLD_INTENT)).toBe(true);
    expect(isCensusHoldIntent(RESTRICTED_WINDOW_INTENT)).toBe(true);
    expect(isCensusHoldIntent('PreToolUse:Edit')).toBe(false);
    expect(isTurnHoldIntent('turn ended')).toBe(false);
    expect(isCensusHoldIntent(null)).toBe(false);
  });

  it('caps the hold at 60 minutes from the edit (D-001)', () => {
    expect(TURN_HOLD_MAX_AGE_MS).toBe(60 * 60 * 1000);
  });

  function capturingSql(answer: () => unknown[]) {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const fn = (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join('?').replace(/\s+/g, ' '), values });
      return Promise.resolve().then(answer);
    };
    return { sql: fn as unknown as FakeSql, calls };
  }

  it('reads edits newer than the editor\'s last turn end, within the max age, excluding ended sessions', async () => {
    const { sql, calls } = capturingSql(() => [{ ...ROW, ts: '2026-10-11T03:00:00Z' }]);
    await expect(readTurnHoldings(sql)).resolves.toHaveLength(1);
    expect(calls).toHaveLength(1);
    const { text, values } = calls[0];
    expect(text).toContain('FROM harness_shared.edit_attribution_ledger l');
    expect(text).toContain('FROM harness_shared.session_turn_journal j');
    // turn_ts (the final assistant message) wins over the asynchronous insert time.
    expect(text).toContain('max(COALESCE(j.turn_ts, j.created_at))');
    expect(text).toContain('r.ts > h.turn_ended_at');
    expect(text).toContain('s.ended_at IS NULL');
    expect(text).toContain('NOT e.session_ended');
    // D-005: the cap is per turn, probed from the turn's oldest edit since its end.
    expect(text).toContain('o.ts > e.turn_ended_at');
    // The default window is D-001's 60 minutes, and the journal window covers it.
    expect(values[0]).toBe(3600);
    expect(values[1]).toBeGreaterThanOrEqual(3600);
    expect(values[2]).toBe(3600);
  });

  it('honours an explicit max age', async () => {
    const { sql, calls } = capturingSql(() => []);
    await readTurnHoldings(sql, { maxAgeMs: 90_000 });
    expect(calls[0].values[0]).toBe(90);
    expect(calls[0].values[2]).toBe(90);
  });

  it('fails closed: an unreadable ledger or journal is a refusal, never an empty census', async () => {
    const { sql } = capturingSql(() => {
      throw new Error('relation "harness_shared.session_turn_journal" does not exist');
    });
    const err = await readTurnHoldings(sql).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DisclosureRefused);
    expect((err as DisclosureRefused).code).toBe('disclosure_ledger_unavailable');
    expect((err as Error).message).toContain('turn-scoped hold');
  });
});

describe('readGitSyncCensusStrict', () => {
  const lock = { path: 'src/a.ts', owner: 'su-peer', intent: 'PreToolUse:Edit' };
  const hold = restrictedHoldingsFromRows([ROW])[0];

  it('is the union of live edit locks and restricted holds', async () => {
    const census = await readGitSyncCensusStrict({ locks: async () => [lock], restricted: async () => [hold] });
    expect(census).toEqual([lock, hold]);
  });

  it('reports start and settlement for each independent census leg', async () => {
    const events: Array<[string, string]> = [];
    await readGitSyncCensusStrict({
      locks: async () => [lock],
      restricted: async () => [hold],
      window: async () => [hold],
      onLeg: (leg, status) => events.push([leg, status]),
    });

    // The turn-holds leg reports even when no turn reader is configured (it settles
    // empty), so a census-timeout diagnostic always names all four legs.
    expect([...GIT_SYNC_CENSUS_LEGS]).toEqual(['live-locks', 'restricted-holds', 'working-tree-window', 'turn-holds']);
    for (const leg of GIT_SYNC_CENSUS_LEGS) {
      expect(events).toContainEqual([leg, 'started']);
      expect(events).toContainEqual([leg, 'completed']);
    }
    expect(events).toHaveLength(8);
  });

  it('adds turn-scoped holds as the fourth leg, after locks, restricted and window holds', async () => {
    const turnHold = turnHoldingsFromRows([{ ...ROW, file: 'src/mid-turn.ts', ts: null }])[0];
    const census = await readGitSyncCensusStrict({
      locks: async () => [lock],
      restricted: async () => [hold],
      turn: async () => [turnHold],
    });
    expect(census).toEqual([lock, hold, turnHold]);
    expect(turnHold.intent).toBe(TURN_HOLD_INTENT);
  });

  it('has no turn holds when no turn reader is passed (the kill-switch OFF path)', async () => {
    const census = await readGitSyncCensusStrict({ locks: async () => [lock], restricted: async () => [] });
    expect(census).toEqual([lock]);
  });

  it('fails closed when the turn-hold read fails', async () => {
    const events: Array<[string, string]> = [];
    const refused = new DisclosureRefused('disclosure_ledger_unavailable', 'turn ledger down');
    await expect(readGitSyncCensusStrict({
      locks: async () => [lock],
      restricted: async () => [],
      turn: async () => Promise.reject(refused),
      onLeg: (leg, status) => events.push([leg, status]),
    })).rejects.toBe(refused);
    expect(events).toContainEqual(['turn-holds', 'failed']);
  });

  it('reports a failed census leg without swallowing its fail-closed error', async () => {
    const events: Array<[string, string]> = [];
    const failure = new Error('restricted ledger unavailable');
    await expect(readGitSyncCensusStrict({
      locks: async () => [lock],
      restricted: async () => { throw failure; },
      window: async () => [],
      onLeg: (leg, status) => events.push([leg, status]),
    })).rejects.toBe(failure);

    expect(events).toContainEqual(['restricted-holds', 'started']);
    expect(events).toContainEqual(['restricted-holds', 'failed']);
  });

  it('throws when the restricted read fails, so git-sync skips the tick instead of staging', async () => {
    const refused = new DisclosureRefused('disclosure_ledger_unavailable', 'down');
    await expect(
      readGitSyncCensusStrict({ locks: async () => [lock], restricted: async () => Promise.reject(refused) }),
    ).rejects.toBe(refused);
  });

  it('throws when the lock read fails', async () => {
    await expect(
      readGitSyncCensusStrict({ locks: async () => Promise.reject(new Error('locks down')), restricted: async () => [] }),
    ).rejects.toThrow('locks down');
  });
});

describe('readRestrictedSourceHoldState', () => {
  it('returns unknown when the integration root is not configured', async () => {
    const readAttributed = vi.fn(async () => []);
    const readWindow = vi.fn(async () => []);
    await expect(readRestrictedSourceHoldState(null, { readAttributed, readWindow })).resolves.toBe('unknown');
    expect(readAttributed).not.toHaveBeenCalled();
    expect(readWindow).not.toHaveBeenCalled();
  });

  it('returns clear only after both source-hold censuses complete', async () => {
    const root = mkdtempSync(join(tmpdir(), 'restricted-source-clear-'));
    const readAttributed = vi.fn(async () => []);
    const readWindow = vi.fn(async () => []);
    try {
      await expect(readRestrictedSourceHoldState(root, { readAttributed, readWindow })).resolves.toBe('clear');
      expect(readAttributed).toHaveBeenCalledOnce();
      expect(readWindow).toHaveBeenCalledWith(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns held when an attributed restricted path is under the integration root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'restricted-source-held-'));
    const hold = {
      path: 'src/private.ts',
      owner: 'su-restricted',
      intent: RESTRICTED_HOLD_INTENT,
      coordinationDomain: root,
    };
    try {
      await expect(
        readRestrictedSourceHoldState(root, {
          readAttributed: async () => [hold],
          readWindow: async () => [],
        }),
      ).resolves.toBe('held');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns unknown when either source-hold census fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'restricted-source-unknown-'));
    try {
      await expect(
        readRestrictedSourceHoldState(root, {
          readAttributed: async () => [],
          readWindow: async () => {
            throw new Error('dirty-window census unavailable');
          },
        }),
      ).resolves.toBe('unknown');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('recordRestrictedEditBeforeRelease', () => {
  const input = { repoRoot: '/srv/papercusp', files: ['notes/secret.md'], ownerId: 'su-restricted' };

  it('writes nothing for an owner with no active disclosure', async () => {
    const recordStrict = vi.fn(async () => {});
    await expect(
      recordRestrictedEditBeforeRelease(input, { hasActiveDisclosure: async () => false, recordStrict }),
    ).resolves.toBe(false);
    expect(recordStrict).not.toHaveBeenCalled();
  });

  it('writes the ledger row for a restricted owner and reports that it did', async () => {
    const recordStrict = vi.fn(async () => {});
    await expect(
      recordRestrictedEditBeforeRelease(input, { hasActiveDisclosure: async () => true, recordStrict }),
    ).resolves.toBe(true);
    expect(recordStrict).toHaveBeenCalledWith(expect.objectContaining({ files: ['notes/secret.md'], ownerId: 'su-restricted' }));
  });

  it('refuses (so locks:release keeps the lock) when the row cannot be written', async () => {
    const err = await recordRestrictedEditBeforeRelease(input, {
      hasActiveDisclosure: async () => true,
      recordStrict: async () => {
        throw new Error('insert failed');
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DisclosureRefused);
    expect((err as DisclosureRefused).code).toBe('disclosure_ledger_unavailable');
  });

  it('refuses when the active-disclosure check itself cannot be read', async () => {
    const { sql } = fakeSql(() => {
      throw new Error('timeout');
    });
    const err = await ownerHasActiveDisclosure(sql, 'su-restricted').catch((e: unknown) => e);
    expect((err as DisclosureRefused).code).toBe('disclosure_ledger_unavailable');
  });
});

/** Run git synchronously for fixture setup; throws on failure. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' }).trim();
}
function configUser(repo: string): void {
  git(repo, 'config', 'user.email', 'test@papercusp.local');
  git(repo, 'config', 'user.name', 'git-sync hold test');
  git(repo, 'config', 'commit.gpgsign', 'false');
}

describe('git-sync holds a restricted session’s file until its disclosure is released (real git)', () => {
  let root: string;
  let originDir: string;
  let repo: string;
  let savedSidecar: string | undefined;
  let warnSpy: ReturnType<typeof vi.spyOn> | undefined;
  const cfg = { pushSubmodules: false } as const;
  const committed = () => git(originDir, 'ls-tree', '-r', '--name-only', 'main').split('\n');

  beforeAll(() => {
    // Exercise the in-process runner regardless of the host's sidecar setting.
    savedSidecar = process.env.PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR;
    process.env.PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR = '0';
  });
  afterAll(() => {
    if (savedSidecar === undefined) delete process.env.PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR;
    else process.env.PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR = savedSidecar;
  });

  beforeEach(() => {
    // runGitSync narrates through console.warn; that is expected here.
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    root = mkdtempSync(join(tmpdir(), 'git-sync-hold-'));
    originDir = join(root, 'origin.git');
    git(root, 'init', '--bare', '-b', 'main', originDir);
    const seed = join(root, 'seed');
    git(root, 'clone', originDir, seed);
    configUser(seed);
    writeFileSync(join(seed, 'README.md'), 'seed\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '--no-verify', '-m', 'init');
    git(seed, 'push', '-u', 'origin', 'main');
    repo = join(root, 'repo');
    git(root, 'clone', originDir, repo);
    configUser(repo);
  });
  afterEach(() => {
    warnSpy?.mockRestore();
    rmSync(root, { recursive: true, force: true });
  });

  /** The census git-sync gets while the disclosure is active: the ledger row for secret.md. */
  const activeHold = () => restrictedHoldingsFromRows([{ ...ROW, repo_root: null, file: 'secret.md', work_item_id: null }]);

  it('leaves the held path out of the commit and the push, and commits it once the hold lifts', async () => {
    writeFileSync(join(repo, 'secret.md'), 'quoted from a private email\n');
    writeFileSync(join(repo, 'normal.md'), 'ordinary work\n');

    const held = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      liveLockHoldings: activeHold(),
      refreshLiveLockHoldings: async () => activeHold(),
    });
    expect(held.status).toBe('synced');
    expect(committed()).toContain('normal.md');
    expect(committed()).not.toContain('secret.md');
    expect(held.skippedPaths).toEqual([
      { scope: 'superproject', path: 'secret.md', owner: 'su-restricted', intent: RESTRICTED_HOLD_INTENT },
    ]);
    expect(git(repo, 'status', '--porcelain', '--', 'secret.md')).toMatch(/secret\.md/);

    // The disclosure is released: the census no longer carries the hold.
    const released = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      liveLockHoldings: [],
      refreshLiveLockHoldings: async () => [],
    });
    expect(released.status).toBe('synced');
    expect(committed()).toContain('secret.md');
  });

  it('a hold that first appears at the final-commit-seam refresh still keeps the path out', async () => {
    writeFileSync(join(repo, 'secret.md'), 'quoted from a private email\n');
    writeFileSync(join(repo, 'normal.md'), 'ordinary work\n');

    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      liveLockHoldings: [],
      refreshLiveLockHoldings: async () => activeHold(),
    });
    expect(['synced', 'skipped-locked']).toContain(out.status);
    expect(committed()).not.toContain('secret.md');
  });

  // WI-10005576: a write with NO ledger row (Bash redirect, sed -i, a script).
  describe('writes made without a native edit tool (window hold)', () => {
    const realGit: HoldRunGit = async (args, cwd) => {
      try {
        const { stdout, stderr } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
        return { code: 0, stdout, stderr };
      } catch (error) {
        const e = error as { code?: number; stdout?: string; stderr?: string };
        return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? String(error) };
      }
    };
    /** The ledger as seen while one disclosure is active since `sinceMs`. */
    const ledgerWith = (sinceMs: number, edits: Array<{ file: string; agent: string; tsMs: number }>) =>
      sequenceSql([
        [{ since: new Date(sinceMs), restricted: ['su-restricted'] }],
        edits.map((e) => ({ repo_root: repo, file: e.file, agent_id: e.agent, ts: new Date(e.tsMs) })),
      ]);

    it('holds a file written inside the window with no ledger row, and commits the attributed and pre-window ones', async () => {
      writeFileSync(join(repo, 'old.md'), 'changed before the disclosure\n');
      const past = new Date(Date.now() - 3_600_000);
      utimesSync(join(repo, 'old.md'), past, past);
      const sinceMs = Date.now() - 60_000;
      writeFileSync(join(repo, 'bash-secret.md'), 'echo "quoted from a private email" > bash-secret.md\n');
      writeFileSync(join(repo, 'peer-native.md'), 'a peer’s native edit\n');
      const peerMtime = statSync(join(repo, 'peer-native.md')).mtimeMs;

      const holds = await readRestrictedWindowHoldings({
        sql: ledgerWith(sinceMs, [{ file: 'peer-native.md', agent: 'su-peer', tsMs: peerMtime + 50 }]),
        listDirtyFiles: () => listDirtyFilesRecursive(realGit, repo),
      });
      expect(holds).toEqual([
        { path: 'bash-secret.md', owner: RESTRICTED_WINDOW_OWNER, intent: RESTRICTED_WINDOW_INTENT, coordinationDomain: repo },
      ]);
      expect(isRestrictedHoldIntent(RESTRICTED_WINDOW_INTENT)).toBe(true);

      const out = await runGitSync('test', { repoPath: repo, config: cfg, liveLockHoldings: holds, refreshLiveLockHoldings: async () => holds });
      expect(out.status).toBe('synced');
      expect(committed()).toEqual(expect.arrayContaining(['old.md', 'peer-native.md']));
      expect(committed()).not.toContain('bash-secret.md');
      expect(git(repo, 'status', '--porcelain', '--', 'bash-secret.md')).toMatch(/bash-secret\.md/);
    });

    it('holds a file whose latest native edit is by a restricted session, or predates the write', async () => {
      const sinceMs = Date.now() - 60_000;
      writeFileSync(join(repo, 'restricted-native.md'), 'x\n');
      writeFileSync(join(repo, 'stale-attribution.md'), 'y\n');
      const holds = await readRestrictedWindowHoldings({
        sql: ledgerWith(sinceMs, [
          { file: 'restricted-native.md', agent: 'su-restricted', tsMs: Date.now() },
          { file: 'stale-attribution.md', agent: 'su-peer', tsMs: sinceMs + 1 }, // edited natively, then rewritten later
        ]),
        listDirtyFiles: () => listDirtyFilesRecursive(realGit, repo),
      });
      expect(holds.map((h) => h.path).sort()).toEqual(['restricted-native.md', 'stale-attribution.md']);
    });

    it('lists files changed inside a submodule under the submodule’s own root', async () => {
      const subOrigin = join(root, 'sub.git');
      git(root, 'init', '--bare', '-b', 'main', subOrigin);
      const subSeed = join(root, 'sub-seed');
      git(root, 'clone', subOrigin, subSeed);
      configUser(subSeed);
      writeFileSync(join(subSeed, 'a.md'), 'a\n');
      git(subSeed, 'add', '-A');
      git(subSeed, 'commit', '--no-verify', '-m', 'sub init');
      git(subSeed, 'push', '-u', 'origin', 'main');
      git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', subOrigin, 'sub');
      git(repo, 'commit', '--no-verify', '-m', 'add sub');
      writeFileSync(join(repo, 'sub', 'secret.md'), 'private\n');
      rmSync(join(repo, 'sub', 'a.md'));

      const dirty = await listDirtyFilesRecursive(realGit, repo);
      expect(dirty).toContainEqual({ root: join(repo, 'sub'), path: 'secret.md' });
      expect(dirty.some((d) => d.path === 'a.md')).toBe(false); // a deletion is never held
    });

    it('costs one query and reads no tree when no disclosure is active', async () => {
      const listDirtyFiles = vi.fn(async () => [{ root: repo, path: 'x.md' }]);
      const sql = sequenceSql([[{ since: null, restricted: null }]]);
      expect(await readRestrictedWindowHoldings({ sql, listDirtyFiles })).toEqual([]);
      expect(listDirtyFiles).not.toHaveBeenCalled();
    });

    it('fails closed when the tree cannot be listed while a disclosure is active', async () => {
      const sql = sequenceSql([[{ since: new Date(), restricted: ['su-restricted'] }]]);
      const listDirtyFiles = async () => Promise.reject(new Error('git status failed'));
      await expect(readRestrictedWindowHoldings({ sql, listDirtyFiles })).rejects.toMatchObject({ code: 'disclosure_ledger_unavailable' });
    });
  });
});

/** A tagged-template fake that answers successive statements from `answers`. */
function sequenceSql(answers: unknown[][]): FakeSql {
  let i = 0;
  const fn = () => Promise.resolve(answers[Math.min(i++, answers.length - 1)] ?? []);
  return fn as unknown as FakeSql;
}
