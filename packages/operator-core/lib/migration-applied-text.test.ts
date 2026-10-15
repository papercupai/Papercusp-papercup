import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as gitBatch from './git-batch';
import { recoverAppliedMigrationText, recoverAppliedMigrationTexts } from './migration-applied-text';

/**
 * EI-19408574209859155: the applied BYTES of a migration are not stored in the
 * database (schema_migrations has only filename/applied_at/sha256), so the only
 * retroactive route to them is git history. These exercise a REAL repository
 * rather than a mock — the whole point of the module is that the git plumbing
 * behaves as expected, which a mock would assume rather than prove.
 */
describe('recoverAppliedMigrationText', () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const p of tmpRoots.splice(0)) fs.rmSync(p, { recursive: true, force: true });
  });

  const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

  /** A repo with `sqlDir` nested inside it, seeded with the given versions of
   *  one migration file (oldest first, one commit each). */
  function makeRepoWithMigrations(files: Record<string, string[]>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'applied-text-'));
    tmpRoots.push(root);
    const sqlDir = path.join(root, 'libs/db/sql');
    fs.mkdirSync(sqlDir, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', root, ...args], {
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: 10_000,
        killSignal: 'SIGKILL',
      });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    const commitCount = Math.max(0, ...Object.values(files).map((versions) => versions.length));
    for (let i = 0; i < commitCount; i += 1) {
      for (const [filename, versions] of Object.entries(files)) {
        if (versions[i] !== undefined) fs.writeFileSync(path.join(sqlDir, filename), versions[i]!);
      }
      git('add', '-A');
      git('commit', '-q', '-m', `v${i}`);
    }
    return sqlDir;
  }

  function makeRepo(filename: string, versions: string[]): string {
    return makeRepoWithMigrations({ [filename]: versions });
  }

  it('recovers the exact bytes that ran, from a historical commit', async () => {
    const applied = 'ALTER TABLE t ADD COLUMN c int;\n';
    const edited = `-- FORWARD-COMPAT: benign.\n${applied}`;
    const sqlDir = makeRepo('727-widen.sql', [applied, edited]);

    const got = await recoverAppliedMigrationText(sqlDir, '727-widen.sql', sha256(applied));
    expect(got.ok).toBe(true);
    expect(got.ok === true && got.text).toBe(applied);
    expect(got.ok === true && got.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('matches the CURRENT version when it is still the applied one (no drift)', async () => {
    const applied = 'SELECT 1;\n';
    const sqlDir = makeRepo('700-a.sql', [applied]);
    const got = await recoverAppliedMigrationText(sqlDir, '700-a.sql', sha256(applied));
    expect(got.ok === true && got.text).toBe(applied);
  });

  it('walks past several intervening commits to find the match', async () => {
    const v = ['a;\n', 'b;\n', 'c;\n', 'd;\n'];
    const sqlDir = makeRepo('701-b.sql', v);
    const got = await recoverAppliedMigrationText(sqlDir, '701-b.sql', sha256(v[0]));
    expect(got.ok === true && got.text).toBe(v[0]);
  });

  it('keeps the event loop responsive while walking git history', async () => {
    const versions = Array.from({ length: 8 }, (_, i) => `SELECT ${i};\n`);
    const sqlDir = makeRepo('701-responsive.sql', versions);
    let recoveryPending = true;
    let timerRanDuringRecovery = false;
    const heartbeat = setInterval(() => {
      if (recoveryPending) timerRanDuringRecovery = true;
    }, 1);

    let got: Awaited<ReturnType<typeof recoverAppliedMigrationText>> | undefined;
    try {
      got = await recoverAppliedMigrationText(sqlDir, '701-responsive.sql', sha256(versions[0]));
    } finally {
      recoveryPending = false;
      clearInterval(heartbeat);
    }

    expect(got?.ok).toBe(true);
    expect(timerRanDuringRecovery).toBe(true);
  });

  it('batches log and blob reads across files by history depth', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => {
        const filename = `${710 + i}-batch.sql`;
        return [filename, [`SELECT ${i};\n`, `SELECT ${i}; -- current edit\n`]];
      }),
    );
    const sqlDir = makeRepoWithMigrations(files);
    const requests = Object.entries(files).map(([filename, versions]) => ({
      filename,
      recordedSha256: sha256(versions[0]!),
    }));
    const batchSpy = vi.spyOn(gitBatch, 'runGitBatch');

    const got = await recoverAppliedMigrationTexts(sqlDir, requests);

    expect(got.map((result) => result.ok)).toEqual(Array(12).fill(true));
    expect(got.map((result) => (result.ok ? result.text : null))).toEqual(
      Object.values(files).map((versions) => versions[0]),
    );
    // One log batch, then one batch for each of the two history depths. The
    // number of migrations no longer multiplies host-side child-process forks.
    expect(batchSpy).toHaveBeenCalledTimes(3);
    expect(batchSpy.mock.calls.map(([commands]) => commands.length)).toEqual([12, 12, 12]);
  });

  it('caches only successful content-addressed recoveries', async () => {
    const applied = 'ALTER TABLE t ADD COLUMN cached int;\n';
    const sqlDir = makeRepo('711-cache.sql', [applied, `${applied}-- edited\n`]);
    const recordedSha256 = sha256(applied);
    const batchSpy = vi.spyOn(gitBatch, 'runGitBatch');

    const first = await recoverAppliedMigrationText(sqlDir, '711-cache.sql', recordedSha256);
    expect(first.ok).toBe(true);
    expect(batchSpy).toHaveBeenCalledTimes(3);

    // Once proven, the exact (dir, filename, sha) result remains useful even
    // if the local checkout is no longer available. A different hash is not
    // covered by that proof and must still attempt Git, then fail closed.
    fs.rmSync(path.resolve(sqlDir, '../../../.git'), { recursive: true, force: true });
    const cached = await recoverAppliedMigrationText(sqlDir, '711-cache.sql', recordedSha256);
    expect(cached).toEqual(first);
    expect(batchSpy).toHaveBeenCalledTimes(3);

    const uncachedHash = await recoverAppliedMigrationText(sqlDir, '711-cache.sql', sha256('other;\n'));
    expect(uncachedHash.ok).toBe(false);
    expect(batchSpy).toHaveBeenCalledTimes(4);
  });

  it('fails (never guesses) when no version matches the recorded hash', async () => {
    // The real "edited inside the git-sync window" case: the applied bytes were
    // never committed, so they are simply not recoverable.
    const sqlDir = makeRepo('702-c.sql', ['a;\n', 'b;\n']);
    const got = await recoverAppliedMigrationText(sqlDir, '702-c.sql', sha256('never-committed;\n'));
    expect(got.ok).toBe(false);
    expect(got.ok === false && got.reason).toMatch(/no blob in the last/);
  });

  it('fails cleanly when the directory is not a git repo at all (packaged install)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'applied-text-nogit-'));
    tmpRoots.push(dir);
    fs.writeFileSync(path.join(dir, '703-d.sql'), 'SELECT 1;\n');
    const got = await recoverAppliedMigrationText(dir, '703-d.sql', sha256('SELECT 1;\n'));
    expect(got.ok).toBe(false);
    expect(got.ok === false && got.reason).toMatch(/git log failed|no git history/);
  });

  it('fails when the file has no history in the tree', async () => {
    const sqlDir = makeRepo('704-e.sql', ['SELECT 1;\n']);
    const got = await recoverAppliedMigrationText(sqlDir, '999-absent.sql', sha256('x'));
    expect(got.ok).toBe(false);
    expect(got.ok === false && got.reason).toMatch(/no git history/);
  });

  it('respects maxCommits, so the walk is bounded', async () => {
    const versions = Array.from({ length: 6 }, (_, i) => `v${i};\n`);
    const sqlDir = makeRepo('705-f.sql', versions);
    // The oldest version is 6 commits back; a 2-commit budget must not find it.
    const bounded = await recoverAppliedMigrationText(sqlDir, '705-f.sql', sha256(versions[0]), {
      maxCommits: 2,
    });
    expect(bounded.ok).toBe(false);
    // ...and with the full budget it does.
    const full = await recoverAppliedMigrationText(sqlDir, '705-f.sql', sha256(versions[0]));
    expect(full.ok).toBe(true);
  });

  it('rejects an unsafe filename before it can reach git argv', async () => {
    const sqlDir = makeRepo('706-g.sql', ['SELECT 1;\n']);
    for (const bad of ['../escape.sql', 'sub/dir.sql', '--upload-pack=evil.sql', 'notsql.txt']) {
      const got = await recoverAppliedMigrationText(sqlDir, bad, sha256('x'));
      expect(got.ok).toBe(false);
      expect(got.ok === false && got.reason).toMatch(/unsafe migration filename|64-hex/);
    }
  });

  it('rejects a malformed recorded sha256 rather than walking history for it', async () => {
    const sqlDir = makeRepo('707-h.sql', ['SELECT 1;\n']);
    for (const bad of ['', 'not-a-hash', 'ABCDEF']) {
      const got = await recoverAppliedMigrationText(sqlDir, '707-h.sql', bad);
      expect(got.ok).toBe(false);
      expect(got.ok === false && got.reason).toMatch(/64-hex digest/);
    }
  });

  it('accepts an upper-case recorded digest (normalized before comparison)', async () => {
    const applied = 'SELECT 42;\n';
    const sqlDir = makeRepo('708-i.sql', [applied]);
    const got = await recoverAppliedMigrationText(sqlDir, '708-i.sql', sha256(applied).toUpperCase());
    expect(got.ok).toBe(true);
  });
});
