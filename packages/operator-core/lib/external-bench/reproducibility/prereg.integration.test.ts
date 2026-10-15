/**
 * prereg.integration.test.ts — the pre-registration "tune-to-test firewall"
 * (benchmark_prereg, migration 291), against a real Postgres. sql is injected via
 * DbScope.sql; the config file is written under a throwaway repoRoot (no real tree).
 *
 * Behaviors a fake-sql unit test can't prove:
 *  - preregister content-hashes the CANONICAL config (key-order-independent) and
 *    records the row + writes the on-disk file;
 *  - re-registering the SAME logical config (keys reordered) is IDEMPOTENT — one
 *    row, same hash (ON CONFLICT (prereg_hash) DO UPDATE) — which only holds because
 *    the hash is canonical (TEETHED: canonicalJson's key sort);
 *  - the IMMUTABILITY firewall: a DIFFERENT config for an already-registered runId
 *    throws (UNIQUE(workspace_id, run_id) → 23505);
 *  - verifyPreregistration recomputes the hash from the on-disk file (tamper →
 *    hashMatches:false) and returns found:false for an unknown run.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const { preregister, verifyPreregistration, computePreregHash, requireCommittedPreregistration } = await import('./prereg');
const { getPrereg } = await import('./store');

const WS = 'ws-prereg';
let rootSql: postgres.Sql;
let repoRoot: string;
const scope = () => ({ sql: rootSql as never, workspaceId: WS });

// An isolated git fixture, never the shared staging checkout. Import its exact
// blob to exercise the real git-history reader without staging product files.
function importFixtureCommit(filePath: string, body: string): void {
  execFileSync('git', ['-c', 'init.defaultBranch=fixture-other', 'init', '-q', '--initial-branch=main'], { cwd: repoRoot });
  const stream = `blob\nmark :1\ndata ${Buffer.byteLength(body)}\n${body}\ncommit refs/heads/main\ncommitter Fixture <fixture@example.invalid> 1577836800 +0000\ndata 6\nfrozen\nM 100644 :1 ${filePath}\n\ndone\n`;
  execFileSync('git', ['fast-import', '--quiet'], { cwd: repoRoot, input: stream });
  expect(execFileSync('git', ['symbolic-ref', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()).toBe('refs/heads/main');
  execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repoRoot });
}

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `prereg_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 2, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // FAITHFUL to migration 291 (PK on prereg_hash + the UNIQUE(workspace_id, run_id) firewall).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.benchmark_prereg (
      prereg_hash text NOT NULL PRIMARY KEY, run_id text NOT NULL, workspace_id text NOT NULL,
      label text, suites jsonb NOT NULL DEFAULT '[]'::jsonb, config jsonb NOT NULL, file_path text NOT NULL,
      git_committed boolean NOT NULL DEFAULT false, git_commit_sha text, created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (workspace_id, run_id)
    )`);
  // verify's predatesRollouts query reads this; never reached here (temp dir isn't a git repo), but be faithful.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.benchmark_run_result (
      run_id text NOT NULL, workspace_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    )`);
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.benchmark_prereg, harness_shared.benchmark_run_result`;
  repoRoot = mkdtempSync(path.join(tmpdir(), 'prereg-repo-'));
});

describe('benchmark pre-registration firewall (PG)', () => {
  it('preregister content-hashes the config, records the row, and writes the file', async () => {
    const config = { arm: 'baseline', seeds: [1, 2, 3], budget: 100 };
    const res = await preregister({ ...scope(), runId: 'R1', suites: [], config, repoRoot });
    expect(res.preregHash).toBe(computePreregHash(config));

    // The real contract: it round-trips through the module's reader as an OBJECT.
    // (The prod client is prepare:false, so jsonb comes back as a string scalar and
    // getPrereg's asJson decodes it — an internal representation the test must not
    // pin; assert the decoded value, not jsonb_typeof.)
    const rec = (await getPrereg({ runId: 'R1' }, scope()))!;
    expect(rec).toMatchObject({ runId: 'R1', preregHash: res.preregHash });
    expect(rec.config).toEqual(config); // decoded back to the object
    expect(rec.filePath).toContain('benchmarks/preregistrations/R1.json');
    // the on-disk file carries the same config + hash
    const doc = JSON.parse(readFileSync(res.absFilePath, 'utf8'));
    expect(doc.preregHash).toBe(res.preregHash);
    expect(doc.config).toEqual(config);
  });

  it('re-registering the SAME config with keys REORDERED is idempotent (one row, same hash)', async () => {
    const first = await preregister({ ...scope(), runId: 'R2', suites: [], config: { a: 1, b: { x: 1, y: 2 } }, repoRoot });
    // same logical config, keys in a different order → canonical hash must be identical
    const second = await preregister({ ...scope(), runId: 'R2', suites: [], config: { b: { y: 2, x: 1 }, a: 1 }, repoRoot });
    expect(second.preregHash).toBe(first.preregHash); // canonical: order-independent
    expect(await rootSql`SELECT 1 FROM harness_shared.benchmark_prereg`).toHaveLength(1); // upsert on prereg_hash, not a 2nd row
  });

  it('IMMUTABILITY firewall: a DIFFERENT config for the same runId throws (UNIQUE run_id)', async () => {
    const original = await preregister({ ...scope(), runId: 'R3', suites: [], config: { tuned: false }, repoRoot });
    const frozenBytes = readFileSync(original.absFilePath, 'utf8');
    // a different config → different hash → new PK but same (ws, run_id) → unique violation
    await expect(
      preregister({ ...scope(), runId: 'R3', suites: [], config: { tuned: true }, repoRoot }),
    ).rejects.toMatchObject({ code: '23505' });
    expect(await rootSql`SELECT 1 FROM harness_shared.benchmark_prereg WHERE run_id='R3'`).toHaveLength(1); // original stands
    expect(readFileSync(original.absFilePath, 'utf8')).toBe(frozenBytes);
    expect((await getPrereg({ runId: 'R3' }, scope()))?.config).toEqual({ tuned: false });
  });

  it('does not retarget an existing content hash to another run or workspace', async () => {
    const config = { frozen: true };
    const original = await preregister({ ...scope(), runId: 'ORIGINAL', suites: [], config, repoRoot });
    await expect(preregister({ ...scope(), runId: 'OTHER', suites: [], config, repoRoot })).rejects.toMatchObject({ code: '23505' });
    await expect(preregister({ ...scope(), workspaceId: 'other-workspace', runId: 'OTHER', suites: [], config, repoRoot })).rejects.toMatchObject({ code: '23505' });
    expect((await getPrereg({ runId: 'ORIGINAL' }, scope()))?.preregHash).toBe(original.preregHash);
    expect(await getPrereg({ runId: 'OTHER' }, scope())).toBeNull();
    expect(existsSync(path.join(repoRoot, 'benchmarks/preregistrations/OTHER.json'))).toBe(false);
  });

  it('preserves bytes on idempotent registration and rejects changed suite metadata', async () => {
    const input = { ...scope(), runId: 'SAME', suites: ['swe-bench-pro'] as const, config: { frozen: true }, repoRoot };
    const original = await preregister({ ...input, suites: [...input.suites] });
    const frozenBytes = readFileSync(original.absFilePath, 'utf8');
    await preregister({ ...input, suites: [...input.suites] });
    expect(readFileSync(original.absFilePath, 'utf8')).toBe(frozenBytes);
    await expect(preregister({ ...input, suites: [] })).rejects.toMatchObject({ code: '23505' });
    expect(readFileSync(original.absFilePath, 'utf8')).toBe(frozenBytes);
  });

  it('serializes concurrent conflicting registrations without splitting file and DB identity', async () => {
    const inputs = [false, true].map(tuned => ({ ...scope(), runId: 'RACE', suites: [], config: { tuned }, repoRoot }));
    const replies = await Promise.allSettled(inputs.map(preregister));
    expect(replies.filter(reply => reply.status === 'fulfilled')).toHaveLength(1);
    const stored = (await getPrereg({ runId: 'RACE' }, scope()))!;
    const disk = JSON.parse(readFileSync(path.join(repoRoot, stored.filePath), 'utf8'));
    expect(disk.config).toEqual(stored.config);
    expect(disk.preregHash).toBe(stored.preregHash);
  });

  it('admits only the exact config in the introducing commit', async () => {
    const config = { tasks: ['t1'], seeds: [1], grader: 'pinned-v1' };
    const res = await preregister({ ...scope(), runId: 'COMMITTED', suites: [], config, repoRoot });
    const expected = { preregHash: res.preregHash, config };
    await expect(requireCommittedPreregistration('COMMITTED', expected, { ...scope(), repoRoot })).rejects.toThrow(/committed/);
    importFixtureCommit(res.filePath, readFileSync(res.absFilePath, 'utf8'));
    expect(await verifyPreregistration('COMMITTED', { ...scope(), repoRoot })).toMatchObject({ committed: true, committedHashMatches: true });
    expect(await requireCommittedPreregistration('COMMITTED', expected, { ...scope(), repoRoot })).toMatchObject({
      preregHash: res.preregHash, gitCommitSha: expect.stringMatching(/^[a-f0-9]{40}$/), receiptRef: expect.stringContaining('prereg:'),
    });
    for (const changed of [{ ...config, tasks: ['t2'] }, { ...config, seeds: [2] }, { ...config, grader: 'v2' }]) {
      await expect(requireCommittedPreregistration('COMMITTED', { ...expected, config: changed }, { ...scope(), repoRoot })).rejects.toThrow(/exact frozen/);
    }
    // The fixture commit is from 2020; an outcome from 2019 disproves prereg order.
    await rootSql`INSERT INTO harness_shared.benchmark_run_result VALUES ('COMMITTED', ${WS}, '2019-01-01'::timestamptz)`;
    await expect(requireCommittedPreregistration('COMMITTED', expected, { ...scope(), repoRoot })).rejects.toThrow(/before outcomes/);
  });

  it('rejects matching current bytes when the introducing git blob had a different protocol', async () => {
    const config = { frozen: true };
    const res = await preregister({ ...scope(), runId: 'WRONG-BLOB', suites: [], config, repoRoot });
    const wrong = { ...JSON.parse(readFileSync(res.absFilePath, 'utf8')), config: { frozen: false } };
    importFixtureCommit(res.filePath, JSON.stringify(wrong));
    expect(await verifyPreregistration('WRONG-BLOB', { ...scope(), repoRoot })).toMatchObject({ hashMatches: true, committed: true, committedHashMatches: false });
    expect((await getPrereg({ runId: 'WRONG-BLOB' }, scope()))?.gitCommitted).toBe(false);
    await expect(requireCommittedPreregistration('WRONG-BLOB', { preregHash: res.preregHash, config }, { ...scope(), repoRoot })).rejects.toThrow(/matching pre-registration/);
  });

  it('rejects a run id that escapes the frozen protocol directory', async () => {
    await expect(preregister({ ...scope(), runId: '../outside', suites: [], config: {}, repoRoot })).rejects.toThrow(/safe file name/);
    expect(await rootSql`SELECT 1 FROM harness_shared.benchmark_prereg`).toHaveLength(0);
  });

  it('verifyPreregistration recomputes the hash from disk (tamper → hashMatches:false); unknown run → found:false', async () => {
    const res = await preregister({ ...scope(), runId: 'R4', suites: [], config: { x: 1 }, repoRoot });
    const ok = await verifyPreregistration('R4', { ...scope(), repoRoot });
    expect(ok).toMatchObject({ found: true, hashMatches: true, committed: false }); // temp dir → not committed

    // tamper the on-disk config → the recomputed hash no longer matches the recorded one
    writeFileSync(res.absFilePath, JSON.stringify({ preregHash: res.preregHash, config: { x: 999 } }), 'utf8');
    expect((await verifyPreregistration('R4', { ...scope(), repoRoot })).hashMatches).toBe(false);

    expect(await verifyPreregistration('NOPE', { ...scope(), repoRoot })).toMatchObject({ found: false, hashMatches: false });
  });
});
