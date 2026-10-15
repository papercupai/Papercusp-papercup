/**
 * Pre-registration (BRIEF 8 / P-010) — the tune-to-test firewall.
 *
 * Before a run, the full run config is content-hashed (sha256 of its canonical
 * JSON) and committed to git at benchmarks/preregistrations/<runId>.json. Every
 * emitted run_result carries that `preregHash`; emitRollout() refuses a row whose
 * hash has no prereg row. A third party recomputes the hash from the published
 * config + checks the file's introducing commit predates the results — so we
 * provably could not have tuned the config to the test set after seeing results.
 *
 * git-sync owns commit/push, so preregister() only WRITES the file into the tree
 * (git-sync carries it within minutes) + records the PG row with the hash +
 * timestamp; verifyPreregistration() later confirms the file landed in git
 * history and stamps the commit sha.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import type { BenchSuite } from '@papercusp/bench-metrics';
import { REPO_ROOT } from '../../agent-tools/docs/_repo-paths';
import { canonicalJson } from './canonical-json';
import { resolveDb, type DbScope } from './db';

const execFileAsync = promisify(execFile);

/** Repo-relative dir the pre-registered config files live under. */
export const PREREG_DIR_REL = path.join('benchmarks', 'preregistrations');

/** Repo-relative path the pre-registered config for `runId` lands at. */
export function preregFilePath(runId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) throw new Error('Pre-registration run id must be a safe file name.');
  return path.join(PREREG_DIR_REL, `${runId}.json`);
}

/** sha256 (lowercase hex) of a config's canonical JSON — the content id. */
export function computePreregHash(config: unknown): string {
  return createHash('sha256').update(canonicalJson(config), 'utf8').digest('hex');
}

const jb = (v: unknown): string | null => (v == null ? null : JSON.stringify(v));
const decoded = (v: unknown): unknown => typeof v === 'string' ? JSON.parse(v) : v;
const immutableConflict = () => Object.assign(new Error('Pre-registration identity/config is immutable; use a new run id and protocol.'), { code: '23505' });

export interface PreregisterInput extends DbScope {
  runId: string;
  label?: string | null;
  suites: BenchSuite[];
  /** The full run config: arms, task set, seeds, budgets, model params, grader versions. */
  config: Record<string, unknown>;
  /** Override the repo root (tests). Default: the resolved monorepo root. */
  repoRoot?: string;
}

export interface PreregisterResult {
  preregHash: string;
  /** Repo-relative path of the committed file. */
  filePath: string;
  /** Absolute path written. */
  absFilePath: string;
}

/**
 * Pre-register a run config: write the canonical config file into the tree and
 * record the PG row. Idempotent for the SAME config (same hash → upsert). A
 * DIFFERENT config for an already-registered runId throws (pre-registration is
 * immutable per run — that immutability is the firewall).
 */
export async function preregister(input: PreregisterInput): Promise<PreregisterResult> {
  const { sql, ws } = resolveDb(input);
  const preregHash = computePreregHash(input.config);
  const filePath = preregFilePath(input.runId);
  const repoRoot = input.repoRoot ?? REPO_ROOT;
  const absFilePath = path.join(repoRoot, filePath);

  const checkFile = () => {
    const doc = JSON.parse(readFileSync(absFilePath, 'utf8')) as { runId?: unknown; preregHash?: unknown; config?: unknown; suites?: unknown };
    if (doc.runId !== input.runId || doc.preregHash !== preregHash ||
        computePreregHash(doc.config) !== preregHash || canonicalJson(doc.suites) !== canonicalJson(input.suites)) throw immutableConflict();
  };
  // Serialize both the DB firewall and the file for this path. In particular a
  // refused INSERT must never overwrite the already-frozen protocol on disk.
  await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${absFilePath}, 0))`;
    if (existsSync(absFilePath)) checkFile();
    await tx`
      INSERT INTO harness_shared.benchmark_prereg
        (prereg_hash, run_id, workspace_id, label, suites, config, file_path)
      VALUES
        (${preregHash}, ${input.runId}, ${ws}, ${input.label ?? null},
         ${jb(input.suites)}::text::jsonb, ${jb(input.config)}::text::jsonb, ${filePath})
      ON CONFLICT (prereg_hash) DO NOTHING
    `;
    const [row] = await tx`
      SELECT run_id, workspace_id, config, suites, label, created_at
        FROM harness_shared.benchmark_prereg WHERE prereg_hash = ${preregHash}
    `;
    if (!row || row.run_id !== input.runId || row.workspace_id !== ws ||
        computePreregHash(decoded(row.config)) !== preregHash ||
        canonicalJson(decoded(row.suites)) !== canonicalJson(input.suites)) throw immutableConflict();
    if (!existsSync(absFilePath)) {
      const fileDoc = { runId: input.runId, preregHash, label: row.label ?? null,
        suites: input.suites, createdAt: new Date(row.created_at).toISOString(), config: input.config };
      mkdirSync(path.dirname(absFilePath), { recursive: true });
      try { writeFileSync(absFilePath, `${JSON.stringify(fileDoc, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        checkFile();
      }
    }
  });

  return { preregHash, filePath, absFilePath };
}

export interface VerifyPreregResult {
  found: boolean;
  /** Hash of the on-disk config matches the recorded prereg_hash. */
  hashMatches: boolean;
  /** The prereg file is present in git history. */
  committed: boolean;
  /** The actual introducing git blob contains the same frozen protocol. */
  committedHashMatches: boolean;
  gitCommitSha: string | null;
  /** The committing commit predates the earliest rollout for this run (null = no rollouts / unknown). */
  predatesRollouts: boolean | null;
}

/**
 * Verify a pre-registration AFTER the fact (reproducer / methodology check):
 * recompute the hash from the on-disk file, confirm the file is in git history,
 * and confirm its introducing commit predates the run's rollouts. Stamps
 * git_committed + git_commit_sha on the row. Never throws on git failure (git-sync
 * may not have committed yet → committed:false).
 */
export async function verifyPreregistration(
  runId: string,
  opts: { repoRoot?: string } & DbScope = {},
): Promise<VerifyPreregResult> {
  const { sql, ws } = resolveDb(opts);
  const repoRoot = opts.repoRoot ?? REPO_ROOT;

  const rows = await sql<{ prereg_hash: string; file_path: string }[]>`
    SELECT prereg_hash, file_path FROM harness_shared.benchmark_prereg
     WHERE run_id = ${runId} AND workspace_id = ${ws} LIMIT 1
  `;
  if (rows.length === 0) {
    return { found: false, hashMatches: false, committed: false, committedHashMatches: false, gitCommitSha: null, predatesRollouts: null };
  }
  const { prereg_hash, file_path } = rows[0];
  const absPath = path.join(repoRoot, file_path);

  let hashMatches = false;
  if (existsSync(absPath)) {
    try {
      const doc = JSON.parse(readFileSync(absPath, 'utf8')) as { runId?: unknown; preregHash?: unknown; config?: unknown };
      hashMatches = doc.runId === runId && doc.preregHash === prereg_hash && computePreregHash(doc.config) === prereg_hash;
    } catch {
      hashMatches = false;
    }
  }

  let committed = false;
  let committedHashMatches = false;
  let gitCommitSha: string | null = null;
  let commitIso: string | null = null;
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['log', '-1', '--diff-filter=A', '--format=%H%x09%cI', '--', file_path],
      { cwd: repoRoot },
    );
    const line = stdout.trim();
    if (line) {
      const [shaPart, isoPart] = line.split('\t');
      gitCommitSha = shaPart || null;
      commitIso = isoPart || null;
      committed = Boolean(gitCommitSha);
      if (gitCommitSha) {
        const blob = await execFileAsync('git', ['show', `${gitCommitSha}:${file_path}`], { cwd: repoRoot });
        const doc = JSON.parse(blob.stdout) as { runId?: unknown; preregHash?: unknown; config?: unknown };
        committedHashMatches = doc.runId === runId && doc.preregHash === prereg_hash && computePreregHash(doc.config) === prereg_hash;
      }
    }
  } catch {
    committed = false;
  }

  let predatesRollouts: boolean | null = null;
  if (commitIso) {
    const earliest = await sql<{ min_created: Date | null }[]>`
      SELECT min(created_at) AS min_created FROM harness_shared.benchmark_run_result
       WHERE run_id = ${runId} AND workspace_id = ${ws}
    `;
    const first = earliest[0]?.min_created;
    predatesRollouts = first ? new Date(commitIso).getTime() <= new Date(first).getTime() : null;
  }

  await sql`
    UPDATE harness_shared.benchmark_prereg
       SET git_committed = ${committed && committedHashMatches && hashMatches}, git_commit_sha = ${gitCommitSha}
     WHERE prereg_hash = ${prereg_hash} AND workspace_id = ${ws}
  `;

  return { found: true, hashMatches, committed, committedHashMatches, gitCommitSha, predatesRollouts };
}

/** The generation-side firewall; bind this BEFORE budget reservation or launch. */
export async function requireCommittedPreregistration(
  runId: string,
  expected: { preregHash: string; config: Record<string, unknown> },
  opts: { repoRoot?: string } & DbScope = {},
): Promise<{ preregHash: string; gitCommitSha: string; receiptRef: string }> {
  const { sql, ws } = resolveDb(opts);
  const [row] = await sql`
    SELECT prereg_hash, config FROM harness_shared.benchmark_prereg
     WHERE run_id = ${runId} AND workspace_id = ${ws} LIMIT 1
  `;
  if (!row || row.prereg_hash !== expected.preregHash ||
      computePreregHash(expected.config) !== expected.preregHash ||
      computePreregHash(decoded(row.config)) !== expected.preregHash) {
    throw new Error('Generation requires the exact frozen pre-registration config.');
  }
  const verified = await verifyPreregistration(runId, opts);
  if (!verified.hashMatches || !verified.committed || !verified.committedHashMatches ||
      !verified.gitCommitSha || verified.predatesRollouts === false) {
    throw new Error('Generation requires matching pre-registration bytes committed before outcomes.');
  }
  return { preregHash: expected.preregHash, gitCommitSha: verified.gitCommitSha,
    receiptRef: `prereg:${ws}/${runId}#${expected.preregHash}@${verified.gitCommitSha}` };
}
