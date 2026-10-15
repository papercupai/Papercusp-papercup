/**
 * P-027 (D-014) — the read-side half of ledger/ref atomicity: a queue row that fell behind
 * `refs/papercusp/frozen/<candidate>` is rebuilt FROM the commits, 1:1, and anything that is
 * not an admit-door commit is refused rather than laundered into the ledger.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createFrozenCandidateQueue,
  parseFrozenCandidateRepairQueue,
  type FrozenCandidateRepairQueue,
} from './frozen-candidate-repair-queue';
import { admitPathsOntoRepairHead, frozenLineageRef } from './repair-head-admission';
import { ADMISSION_GIT_DATE_MS } from './admission-commit-date';
import {
  countReconciledAdmissions,
  parseAdmissionCommitMessage,
  reconcileFrozenRepairQueueWithLineageRef,
} from './frozen-lineage-ledger-reconcile';

const TEMP: string[] = [];
afterEach(() => {
  for (const d of TEMP.splice(0)) rmSync(d, { recursive: true, force: true });
});

const HOME = mkdtempSync(join(tmpdir(), 'reconcile-home-'));
TEMP.push(HOME);
const GIT_ENV = {
  ...process.env,
  HOME,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@test.local',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@test.local',
};

function git(root: string, args: string[], input?: string): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: GIT_ENV,
    timeout: 30_000,
    killSignal: 'SIGKILL',
    ...(input !== undefined ? { input } : {}),
  }).trim();
}
function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}
function sweep(root: string, edits: Record<string, string>, msg: string): string {
  for (const [rel, content] of Object.entries(edits)) write(root, rel, content);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', msg]);
  return git(root, ['rev-parse', 'HEAD']);
}

/** First commit is the frozen candidate; `staging` is the shared tree the fixes land on. */
function repo(): { root: string; candidate: string } {
  const root = mkdtempSync(join(tmpdir(), 'reconcile-repo-'));
  TEMP.push(root);
  git(root, ['init', '-q', '-b', 'staging']);
  write(root, 'lib/a.ts', 'export const a = 1;\n');
  write(root, 'lib/b.ts', 'export const b = 1;\n');
  write(root, 'lib/c.ts', 'export const c = 1;\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'candidate']);
  return { root, candidate: git(root, ['rev-parse', 'HEAD']) };
}

const T0 = 1_800_000_000_000;

function queueAt(candidate: string): FrozenCandidateRepairQueue {
  return createFrozenCandidateQueue({ candidate, base: null, nowMs: T0, failingTests: ['lib/a.test.ts'] });
}

function admit(root: string, candidate: string, repairHead: string, paths: string[], actor = 'su-door', reason?: string): string {
  const out = admitPathsOntoRepairHead({ root, candidate, repairHead, paths, source: { ref: 'staging' }, actor, nowMs: T0, ...(reason ? { reason } : {}) });
  if (!out.ok) throw new Error(`fixture admission refused: ${out.code} ${out.detail}`);
  return out.commit;
}

describe('parseAdmissionCommitMessage — the admit door\'s trailers, and nothing else', () => {
  const C = 'a'.repeat(40);
  const H = 'b'.repeat(40);
  const S = 'c'.repeat(40);
  it('parses the exact message buildAdmissionMessage writes, reason optional', () => {
    const msg = `admit 2 path(s) onto frozen lineage ${C.slice(0, 12)}\n\ncandidate: ${C}\nrepairHead: ${H}\nsource: staging@${S}\nactor: su-1\nreason: fix the red\npaths:\n- lib/b.ts\n- lib/a.ts\n`;
    expect(parseAdmissionCommitMessage(msg)).toEqual({
      candidate: C,
      repairHead: H,
      source: { ref: 'staging', sha: S },
      actor: 'su-1',
      reason: 'fix the red',
      paths: ['lib/a.ts', 'lib/b.ts'],
    });
    expect(parseAdmissionCommitMessage(msg.replace('reason: fix the red\n', ''))?.reason).toBeUndefined();
  });
  it('refuses a message missing any trailer, a malformed sha, an empty paths block, or prose after the paths', () => {
    const base = `x\n\ncandidate: ${C}\nrepairHead: ${H}\nsource: staging@${S}\nactor: su-1\npaths:\n- lib/a.ts\n`;
    expect(parseAdmissionCommitMessage(base)).not.toBeNull();
    expect(parseAdmissionCommitMessage(base.replace(`actor: su-1\n`, ''))).toBeNull();
    expect(parseAdmissionCommitMessage(base.replace(`source: staging@${S}\n`, ''))).toBeNull();
    expect(parseAdmissionCommitMessage(base.replace(H, 'not-a-sha'))).toBeNull();
    expect(parseAdmissionCommitMessage(base.replace('- lib/a.ts\n', ''))).toBeNull();
    expect(parseAdmissionCommitMessage(`${base}Signed-off-by: someone\n`)).toBeNull();
    expect(parseAdmissionCommitMessage('merge staging into lineage\n')).toBeNull();
  });
});

describe('reconcileFrozenRepairQueueWithLineageRef — real git (P-027 / D-014)', () => {
  it('is in-sync when the ref is absent and the row is at the candidate, and when the ref is at the row\'s repairHead', () => {
    const { root, candidate } = repo();
    const q0 = queueAt(candidate);
    const absent = reconcileFrozenRepairQueueWithLineageRef(q0, { root });
    expect(absent).toMatchObject({ status: 'in-sync', refHead: null, reconciled: [] });
    expect(absent.queue).toBe(q0);

    sweep(root, { 'lib/a.ts': 'export const a = 2;\n' }, 'fix a');
    const h1 = admit(root, candidate, candidate, ['lib/a.ts']);
    const q1 = { ...q0, repairHead: h1 };
    const synced = reconcileFrozenRepairQueueWithLineageRef(q1, { root });
    expect(synced).toMatchObject({ status: 'in-sync', refHead: h1, reconciled: [] });
    expect(synced.queue).toBe(q1);
  });

  it('rebuilds one ledger entry per lineage commit the row lacks — derived from the commit, provenance stamped, repairHead advanced to the ref', () => {
    const { root, candidate } = repo();
    // Two admissions land on the ref; the row never saw either (the lost-update shape).
    sweep(root, { 'lib/a.ts': 'export const a = 2;\n' }, 'fix a');
    const h1 = admit(root, candidate, candidate, ['lib/a.ts', 'lib/c.ts'], 'su-one', 'first  fix');
    const srcB = sweep(root, { 'lib/b.ts': 'export const b = 2;\n' }, 'fix b');
    const h2 = admit(root, candidate, h1, ['lib/b.ts'], 'su-two');
    expect(git(root, ['rev-parse', frozenLineageRef(candidate)])).toBe(h2);

    const stale = queueAt(candidate); // repairHead === candidate, admissions absent
    const reconciledAtMs = T0 + 60_000;
    const out = reconcileFrozenRepairQueueWithLineageRef(stale, { root, nowMs: reconciledAtMs });
    expect(out.status).toBe('reconciled');
    expect(out.refHead).toBe(h2);
    expect(out.queue).not.toBe(stale);
    expect(out.queue.repairHead).toBe(h2);
    expect(out.queue.admissions).toHaveLength(2);
    expect(out.reconciled).toEqual(out.queue.admissions);

    const [e1, e2] = out.queue.admissions!;
    // Entry 1: chained on the candidate; `paths` is what CHANGED (diff-tree), `unchanged` is the
    // allowlisted path whose blob already equalled repairHead's; blobs read off the commit.
    expect(e1).toMatchObject({
      fromRepairHead: candidate,
      toRepairHead: h1,
      actor: 'su-one',
      reason: 'first fix',
      paths: ['lib/a.ts'],
      unchanged: ['lib/c.ts'],
      source: { ref: 'staging' },
      provenance: 'reconciled-from-ref',
    });
    expect(e1.blobs['lib/a.ts']).toBe(git(root, ['rev-parse', `${h1}:lib/a.ts`]));
    // WI-10006866: door commits carry the synthetic ADMISSION_GIT_DATE (deterministic shas), so
    // their committer time is NOT an admission time. Positive control first: the commit really is
    // synthetic. Then: the rebuilt entry records when the row learned of it, never 2000-01-01.
    expect(Number(git(root, ['show', '-s', '--format=%ct', h1])) * 1000).toBe(ADMISSION_GIT_DATE_MS);
    expect(e1.atMs).toBe(reconciledAtMs);
    expect(out.queue.admissions!.every((a) => a.atMs !== ADMISSION_GIT_DATE_MS)).toBe(true);
    // Entry 2: chained on entry 1's head, from the staging commit that carried fix b.
    expect(e2).toMatchObject({
      fromRepairHead: h1,
      toRepairHead: h2,
      actor: 'su-two',
      paths: ['lib/b.ts'],
      unchanged: [],
      source: { ref: 'staging', sha: srcB },
      provenance: 'reconciled-from-ref',
    });
    expect(e2.reason).toBeUndefined();
    // The newer head is UNJUDGED: the reducer flipped the queue back into verification.
    expect(out.queue.phase).toBe('ready-to-test');
    expect(countReconciledAdmissions(out.queue)).toBe(2);
    expect(out.detail).toContain(h1.slice(0, 12));
    expect(out.detail).toContain(h2.slice(0, 12));

    // Idempotent: a second pass over the reconciled row finds the ref in sync.
    expect(reconcileFrozenRepairQueueWithLineageRef(out.queue, { root }).status).toBe('in-sync');
    // And the provenance survives the row's own JSON round-trip (parseFrozenCandidateRepairQueue).
    const parsed = parseFrozenCandidateRepairQueue(JSON.parse(JSON.stringify(out.queue)));
    expect(parsed?.admissions?.map((a) => a.provenance)).toEqual(['reconciled-from-ref', 'reconciled-from-ref']);
  });

  it('reconciles only the TAIL the row lacks when the row already ledgers part of the lineage', () => {
    const { root, candidate } = repo();
    sweep(root, { 'lib/a.ts': 'export const a = 2;\n' }, 'fix a');
    const h1 = admit(root, candidate, candidate, ['lib/a.ts']);
    sweep(root, { 'lib/b.ts': 'export const b = 2;\n' }, 'fix b');
    const h2 = admit(root, candidate, h1, ['lib/b.ts']);
    const rowAtH1 = { ...queueAt(candidate), repairHead: h1 };
    const out = reconcileFrozenRepairQueueWithLineageRef(rowAtH1, { root });
    expect(out.status).toBe('reconciled');
    expect(out.reconciled.map((e) => [e.fromRepairHead, e.toRepairHead])).toEqual([[h1, h2]]);
    expect(out.queue.repairHead).toBe(h2);
  });

  it('refuses to repair a ref that is BEHIND the row, a diverged lineage, or a foreign commit on the gate\'s ref — the row is returned untouched', () => {
    const { root, candidate } = repo();
    sweep(root, { 'lib/a.ts': 'export const a = 2;\n' }, 'fix a');
    const h1 = admit(root, candidate, candidate, ['lib/a.ts']);
    sweep(root, { 'lib/b.ts': 'export const b = 2;\n' }, 'fix b');
    const h2 = admit(root, candidate, h1, ['lib/b.ts']);
    const ref = frozenLineageRef(candidate);

    // ref reset below the row (a retract / a manual reset): not ours to undo.
    git(root, ['update-ref', ref, h1, h2]);
    const rowAtH2 = { ...queueAt(candidate), repairHead: h2 };
    const behind = reconcileFrozenRepairQueueWithLineageRef(rowAtH2, { root });
    expect(behind.status).toBe('ref-behind-row');
    expect(behind.queue).toBe(rowAtH2);

    // ref absent while the row claims a head: the row is ahead of git.
    git(root, ['update-ref', '-d', ref]);
    expect(reconcileFrozenRepairQueueWithLineageRef(rowAtH2, { root }).status).toBe('ref-absent');

    // a lineage the row's head is not on at all.
    git(root, ['update-ref', ref, h2]);
    const foreignHead = sweep(root, { 'lib/c.ts': 'export const c = 9;\n' }, 'unrelated staging commit');
    const rowElsewhere = { ...queueAt(candidate), repairHead: foreignHead };
    const diverged = reconcileFrozenRepairQueueWithLineageRef(rowElsewhere, { root });
    expect(diverged.status).toBe('lineage-diverged');
    expect(diverged.queue).toBe(rowElsewhere);

    // a commit on the gate's ref that the admit door did not write (no trailers).
    const tree = git(root, ['rev-parse', `${foreignHead}^{tree}`]);
    const foreign = git(root, ['commit-tree', tree, '-p', h2], 'hand-made commit on the lineage ref\n');
    git(root, ['update-ref', ref, foreign, h2]);
    const stale = queueAt(candidate);
    const unreadable = reconcileFrozenRepairQueueWithLineageRef(stale, { root });
    expect(unreadable.status).toBe('commit-unreadable');
    expect(unreadable.detail).toContain(foreign.slice(0, 12));
    expect(unreadable.detail).toContain('foreign commit');
    expect(unreadable.queue).toBe(stale);
    expect(unreadable.reconciled).toEqual([]);
  });

  it('positive control for the refusals: with the foreign commit removed the same row reconciles', () => {
    const { root, candidate } = repo();
    sweep(root, { 'lib/a.ts': 'export const a = 2;\n' }, 'fix a');
    const h1 = admit(root, candidate, candidate, ['lib/a.ts']);
    const out = reconcileFrozenRepairQueueWithLineageRef(queueAt(candidate), { root });
    expect(out.status).toBe('reconciled');
    expect(out.queue.repairHead).toBe(h1);
  });
});
