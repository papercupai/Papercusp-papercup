/**
 * The git-sync turn-scoped commit hold against real Postgres and a real git repository
 * (plan git-sync-turn-scoped-commit-hold-2026-10-11 P-005, WI-6554700010008397).
 *
 * The rule under test (readTurnHoldings in git-sync-hold.ts):
 *
 *   a path a session natively edited is held from git-sync's commit while the edit is
 *   newer than that session's last recorded turn end, unless the edit is older than the
 *   maximum age (D-001: 60 min) or every recorded session of the editor has ended.
 *
 * Each boundary is a fixture owner below. The second describe drives runGitSync on a
 * throwaway repository so the effect is measured at the commit, not assumed: two files
 * edited mid-turn are left out while an unrelated file commits, and both land together
 * on the first tick after the turn end is recorded.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const holder = vi.hoisted(() => ({ sql: null as postgres.Sql | null }));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: holder.sql }),
}));

const { createOrgTestDb } = await import('../../test/_org-test-db');
const { readTurnHoldings, readGitSyncCensusStrict, TURN_HOLD_INTENT } = await import('./git-sync-hold');
const { runGitSync } = await import('../harness/git-sync/run-git-sync');
type OrgTestDb = import('../../test/_org-test-db').OrgTestDb;

const WS = 'git-sync-turn-hold-test';
const REPO = '/repo/turn-hold';
const LIVE = 'su-turn-live';
const LAG = 'su-turn-journal-lag';
const NULL_TS = 'su-turn-null-turn-ts';
const ENDED = 'su-turn-ended';
const RESPAWN = 'su-turn-respawned';
const NO_SESSION = 'su-turn-no-session';
const NEVER_JOURNALED = 'su-turn-never-journaled';
const OLD_JOURNAL = 'su-turn-old-journal';
const LONG_TURN = 'su-turn-long-turn';
const OWNERS = [LIVE, LAG, NULL_TS, ENDED, RESPAWN, NO_SESSION, NEVER_JOURNALED, OLD_JOURNAL, LONG_TURN];

let org: OrgTestDb;
let sql: postgres.Sql;
let sessionSeq = 0;
/** The newest edit of LIVE's mid-turn.ts: the time its hold is reported as held since. */
let midTurnLatestEdit = '';

const ago =(minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();

async function edit(agent: string, repoRoot: string, file: string, ts: string): Promise<void> {
  await sql`
    INSERT INTO harness_shared.edit_attribution_ledger (workspace_id, repo_root, file, agent_id, ts)
    VALUES (${WS}, ${repoRoot}, ${file}, ${agent}, ${ts}::timestamptz)`;
}

/** `kind` is the client that recorded the turn end; the hold reads every client's rows alike (R-1). */
async function turnEnd(
  owner: string,
  turnTs: string | null,
  createdAt: string,
  kind: 'claude' | 'codex' | 'omp' = 'claude',
): Promise<void> {
  sessionSeq += 1;
  await sql`
    INSERT INTO harness_shared.session_turn_journal
      (workspace_id, owner_id, agent, source_kind, session_id, turn_ts, note, source, created_at)
    VALUES (${WS}, ${owner}, ${kind}, ${kind}, ${`turn-hold-session-${sessionSeq}`},
            ${turnTs}::timestamptz, 'turn ended', 'mechanical', ${createdAt}::timestamptz)`;
}

async function session(owner: string, endedAt: string | null): Promise<void> {
  await sql`
    INSERT INTO harness_shared.adv_sessions (workspace_id, mode, coord_owner_id, ended_at)
    VALUES (${WS}, 'console', ${owner}, ${endedAt}::timestamptz)`;
}

async function cleanupOwners(owners: readonly string[]): Promise<void> {
  await sql`DELETE FROM harness_shared.edit_attribution_ledger WHERE agent_id = ANY(${owners as string[]})`;
  await sql`DELETE FROM harness_shared.session_turn_journal WHERE owner_id = ANY(${owners as string[]})`;
  await sql`DELETE FROM harness_shared.adv_sessions WHERE coord_owner_id = ANY(${owners as string[]})`;
}

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  holder.sql = sql;

  // LIVE: its last turn ended 20 min ago, so an older edit is released and a newer one held.
  await session(LIVE, null);
  await turnEnd(LIVE, ago(20), ago(19));
  await edit(LIVE, REPO, 'released-before-turn-end.ts', ago(30));
  await edit(LIVE, REPO, 'mid-turn.ts', ago(8));
  midTurnLatestEdit = ago(5);
  await edit(LIVE, REPO, 'mid-turn.ts', midTurnLatestEdit);

  // LAG: the journal row was INSERTED 2 min ago, but the turn really ended 10 min ago
  // (turn_ts). An edit 5 min ago belongs to the NEXT turn and must stay held.
  await session(LAG, null);
  await turnEnd(LAG, ago(10), ago(2), 'codex');
  await edit(LAG, REPO, 'next-turn.ts', ago(5));

  // NULL_TS: no transcript turn time, so the insert time is the turn end.
  await session(NULL_TS, null);
  await turnEnd(NULL_TS, null, ago(15), 'omp');
  await edit(NULL_TS, REPO, 'null-ts-before.ts', ago(20));
  await edit(NULL_TS, REPO, 'null-ts-after.ts', ago(1));

  // ENDED: the session is over (crash or exit) without a recorded turn end.
  await session(ENDED, ago(3));
  await edit(ENDED, REPO, 'crashed.ts', ago(5));

  // RESPAWN: a carry-respawn leaves an ended row and an open successor row.
  await session(RESPAWN, ago(30));
  await session(RESPAWN, null);
  await turnEnd(RESPAWN, ago(40), ago(40));
  await edit(RESPAWN, REPO, 'respawned.ts', ago(5));

  // NO_SESSION: no session row, but a journaled earlier turn — held, only within the max age.
  await turnEnd(NO_SESSION, ago(60), ago(60));
  await edit(NO_SESSION, REPO, 'recent.ts', ago(10));
  await edit(NO_SESSION, REPO, 'stale.ts', ago(70));

  // NEVER_JOURNALED: a live session whose host never journals turn ends (a stale
  // Codex home, WI-6554700010008402). Nothing could release it early, so it is not held.
  await session(NEVER_JOURNALED, null);
  await edit(NEVER_JOURNALED, REPO, 'unjournaled.ts', ago(2));

  // OLD_JOURNAL: its only journal row is days old, far outside the turn-end window.
  // Journaling capability is not windowed, so its current long turn is still held.
  await session(OLD_JOURNAL, null);
  await turnEnd(OLD_JOURNAL, ago(3 * 24 * 60), ago(3 * 24 * 60));
  await edit(OLD_JOURNAL, REPO, 'long-turn.ts', ago(3));

  // LONG_TURN: one turn, now past the 60-minute cap, edited a source early and its
  // importer recently. D-005: the cap is per turn, so BOTH are released together; a
  // per-edit cap would commit source.ts and keep importer.ts held.
  await session(LONG_TURN, null);
  await turnEnd(LONG_TURN, ago(90), ago(90));
  await edit(LONG_TURN, REPO, 'source.ts', ago(65));
  await edit(LONG_TURN, REPO, 'importer.ts', ago(10));
});

afterAll(async () => {
  if (org) await cleanupOwners(OWNERS).catch(() => {});
  holder.sql = null;
  await org?.cleanup();
});

describe('readTurnHoldings (real Postgres)', () => {
  const heldPaths = async (opts?: { maxAgeMs?: number }) =>
    (await readTurnHoldings(sql, opts))
      .filter((h) => h.coordinationDomain === REPO)
      .map((h) => `${h.owner} ${h.path}`)
      .sort();

  it('holds exactly the edits made during each live session\'s current turn', async () => {
    expect(await heldPaths()).toEqual([
      `${LAG} next-turn.ts`,
      `${LIVE} mid-turn.ts`,
      `${NO_SESSION} recent.ts`,
      `${NULL_TS} null-ts-after.ts`,
      `${OLD_JOURNAL} long-turn.ts`,
      `${RESPAWN} respawned.ts`,
    ]);
  });

  it('does not hold an editor whose host has never journaled a turn end (WI-6554700010008402)', async () => {
    const held = await heldPaths();
    expect(held.some((p) => p.startsWith(`${NEVER_JOURNALED} `))).toBe(false);
    // Positive control: the same query does hold a journaling owner's equally recent edit.
    expect(held).toContain(`${OLD_JOURNAL} long-turn.ts`);
  });

  it('keeps one holding per path, stamped with the turn-hold intent and the newest edit time', async () => {
    const holdings = (await readTurnHoldings(sql)).filter((h) => h.path === 'mid-turn.ts');
    expect(holdings).toEqual([
      {
        path: 'mid-turn.ts',
        owner: LIVE,
        intent: TURN_HOLD_INTENT,
        coordinationDomain: REPO,
        heldSince: new Date(midTurnLatestEdit).toISOString(),
      },
    ]);
  });

  it('releases a turn\'s files together once the turn outlives the cap, never one at a time (D-005)', async () => {
    const held = await heldPaths();
    // Neither file of the over-cap turn is held: they commit in the same run.
    expect(held.filter((p) => p.startsWith(`${LONG_TURN} `))).toEqual([]);
    // Positive control: a journaling owner within the cap is still held.
    expect(held).toContain(`${LIVE} mid-turn.ts`);
  });

  it('measures the cap from the turn\'s OLDEST edit, so a newer edit cannot keep the turn held', async () => {
    // A 7-minute cap: LIVE edited mid-turn.ts 8 min ago (and again 5 min ago), so its
    // whole turn is released; NO_SESSION's 10-minute edit releases it too. Turns whose
    // every edit is within 7 minutes stay held.
    expect(await heldPaths({ maxAgeMs: 7 * 60_000 })).toEqual([
      `${LAG} next-turn.ts`,
      `${NULL_TS} null-ts-after.ts`,
      `${OLD_JOURNAL} long-turn.ts`,
      `${RESPAWN} respawned.ts`,
    ]);
  });

  it('fails closed: an unreadable turn journal is a refusal, never an empty census', async () => {
    await sql.begin(async (tx) => {
      await tx`ALTER TABLE harness_shared.session_turn_journal RENAME TO session_turn_journal_hidden`;
      await expect(readTurnHoldings(tx)).rejects.toMatchObject({ code: 'disclosure_ledger_unavailable' });
      throw new Error('rollback');
    }).catch((error: Error) => {
      if (error.message !== 'rollback') throw error;
    });
  });
});

describe('git-sync with the turn hold (real Postgres + real git)', () => {
  const E2E = 'su-turn-e2e';
  let root: string;
  let origin: string;
  let repo: string;

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' }).trim();
  const configUser = (dir: string): void => {
    git(dir, 'config', 'user.email', 'test@papercusp.local');
    git(dir, 'config', 'user.name', 'git-sync turn-hold test');
    git(dir, 'config', 'commit.gpgsign', 'false');
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'git-sync-turn-hold-'));
    origin = join(root, 'origin.git');
    git(root, 'init', '--bare', '-b', 'main', origin);
    const seed = join(root, 'seed');
    git(root, 'clone', origin, seed);
    configUser(seed);
    writeFileSync(join(seed, 'README.md'), 'seed\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '--no-verify', '-m', 'init');
    git(seed, 'push', '-u', 'origin', 'main');
    repo = join(root, 'repo');
    git(root, 'clone', origin, repo);
    configUser(repo);
    await session(E2E, null);
    // An earlier journaled turn: only owners whose host journals turn ends are held.
    await turnEnd(E2E, ago(30), ago(30));
  });

  afterEach(async () => {
    await cleanupOwners([E2E]);
    rmSync(root, { recursive: true, force: true });
  });

  /** The census git-sync-action builds, translated to the repo root (the holdings' domain IS that root). */
  const census = async () =>
    (await readGitSyncCensusStrict({ locks: async () => [], turn: () => readTurnHoldings() }))
      .filter((h) => h.coordinationDomain === repo)
      .map(({ path, owner, intent, heldSince }) => ({ path, owner, intent, ...(heldSince ? { heldSince } : {}) }));

  const tick = async () => {
    const liveLockHoldings = await census();
    return runGitSync('turn-hold-test', {
      repoPath: repo,
      config: { pushSubmodules: false },
      liveLockHoldings,
      refreshLiveLockHoldings: census,
      log: () => {},
    });
  };

  it('holds a mid-turn multi-file edit, then commits it together after the turn ends', async () => {
    // Mid-turn: two coupled files edited, plus an unrelated file nobody natively edited.
    await edit(E2E, repo, 'provider.ts', ago(2));
    await edit(E2E, repo, 'consumer.ts', ago(1));
    writeFileSync(join(repo, 'provider.ts'), 'export const value = 2;\n');
    writeFileSync(join(repo, 'consumer.ts'), "import { value } from './provider';\n");
    writeFileSync(join(repo, 'unrelated.txt'), 'swept as usual\n');

    const first = await tick();
    expect(first.status).toBe('synced');
    expect(first.skippedPaths?.map((s) => ('owner' in s ? `${s.owner} ${s.path} ${s.intent === TURN_HOLD_INTENT}` : s.path)).sort())
      .toEqual([`${E2E} consumer.ts true`, `${E2E} provider.ts true`]);
    // P-003: the skipped record carries the edit time, so git-sync health can report the hold's age.
    for (const skipped of first.skippedPaths ?? []) {
      expect('heldSince' in skipped && typeof skipped.heldSince === 'string').toBe(true);
    }
    const afterFirst = git(origin, 'ls-tree', '-r', '--name-only', 'main');
    expect(afterFirst).toContain('unrelated.txt');
    expect(afterFirst).not.toContain('provider.ts');
    expect(afterFirst).not.toContain('consumer.ts');

    // The turn ends: both files land in ONE commit on the next tick.
    await turnEnd(E2E, new Date().toISOString(), new Date().toISOString());
    const second = await tick();
    expect(second.status).toBe('synced');
    expect(second.skippedPaths ?? []).toEqual([]);
    const lastCommitFiles = git(origin, 'show', '--name-only', '--format=', 'main').split('\n').filter(Boolean).sort();
    expect(lastCommitFiles).toEqual(['consumer.ts', 'provider.ts']);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('also holds a dirty file importing a held path, even one written without a native edit', async () => {
    await edit(E2E, repo, 'provider.ts', ago(1));
    writeFileSync(join(repo, 'provider.ts'), 'export const value = 3;\n');
    // Written through Bash: no ledger row of its own, but committing it alone would break HEAD.
    writeFileSync(join(repo, 'wires.ts'), "import { value } from './provider';\nexport const doubled = value * 2;\n");

    const first = await tick();
    // The held file is a skipped path; its importer is held by git-sync's live-lock importer
    // guard, which reports it as a content error naming the exclusion, not as a skipped path.
    expect((first.skippedPaths ?? []).map((s) => s.path)).toEqual(['provider.ts']);
    expect(JSON.stringify(first.contentErrors ?? [])).toMatch(/wires\.ts.*live-lock exclusion/);
    expect(git(origin, 'ls-tree', '-r', '--name-only', 'main')).not.toContain('wires.ts');

    await turnEnd(E2E, new Date().toISOString(), new Date().toISOString(), 'codex');
    const second = await tick();
    expect(second.skippedPaths ?? []).toEqual([]);
    const lastCommitFiles = git(origin, 'show', '--name-only', '--format=', 'main').split('\n').filter(Boolean).sort();
    expect(lastCommitFiles).toEqual(['provider.ts', 'wires.ts']);
  });

  it('releases the files of a session that ended without recording a turn end', async () => {
    await edit(E2E, repo, 'orphan.ts', ago(1));
    writeFileSync(join(repo, 'orphan.ts'), 'export {};\n');
    expect((await tick()).skippedPaths?.map((s) => s.path)).toEqual(['orphan.ts']);

    await sql`UPDATE harness_shared.adv_sessions SET ended_at = now() WHERE coord_owner_id = ${E2E}`;
    const released = await tick();
    expect(released.skippedPaths ?? []).toEqual([]);
    expect(git(origin, 'ls-tree', '-r', '--name-only', 'main')).toContain('orphan.ts');
  });
});
