import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sql } from 'postgres';

const h = vi.hoisted(() => ({ commitAndReproject: vi.fn() }));
vi.mock('../commit-reproject', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../commit-reproject')>()),
  commitAndReproject: h.commitAndReproject,
}));

import { acceptProposalViaCommit, realGitCommit } from '../commit-reproject-real';

/**
 * P-016 — the git wiring of commit → reproject, exercised against a REAL temp git
 * repo (no PG): a repo path commits + returns a SHA; a no-op edit skips the commit;
 * a non-repo (requiresRepo:false target) returns null without throwing.
 */

let dir: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' }).trim();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cr-real-'));
  h.commitAndReproject.mockResolvedValue({
    ok: true, committed: true, commit: 'commit-1', contentHash: 'hash-1',
    editedPath: '.papercusp/prompts/worker.md', blueprintPath: '.papercusp/blueprint.yaml',
  });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('realGitCommit', () => {
  it('commits a .papercusp prompt edit in a git repo and returns the new SHA', async () => {
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    // a base commit so HEAD exists
    writeFileSync(join(dir, 'README'), 'x');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'base');
    const head0 = git(dir, 'rev-parse', 'HEAD');

    mkdirSync(join(dir, '.papercusp', 'prompts'), { recursive: true });
    writeFileSync(join(dir, '.papercusp', 'prompts', 'worker.md'), 'new prompt');
    const sha = await realGitCommit(dir, ['.papercusp/prompts/worker.md'], 'gym: accept worker prompt');

    expect(sha).toBeTruthy();
    expect(sha).not.toBe(head0); // a new commit was made
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(sha);
    expect(git(dir, 'log', '-1', '--pretty=%s')).toBe('gym: accept worker prompt');
  });

  it('a no-op edit (content unchanged) makes NO new commit but returns current HEAD', async () => {
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    mkdirSync(join(dir, '.papercusp', 'prompts'), { recursive: true });
    writeFileSync(join(dir, '.papercusp', 'prompts', 'worker.md'), 'same');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'base with prompt');
    const head0 = git(dir, 'rev-parse', 'HEAD');

    // rewrite the SAME content → nothing staged → no new commit
    writeFileSync(join(dir, '.papercusp', 'prompts', 'worker.md'), 'same');
    const sha = await realGitCommit(dir, ['.papercusp/prompts/worker.md'], 'no-op');

    expect(sha).toBe(head0); // unchanged HEAD, not a new commit
  });

  it('returns null for a non-git dir (a requiresRepo:false / repo-less target)', async () => {
    // dir is a plain temp dir, never `git init`ed
    writeFileSync(join(dir, 'x.md'), 'y');
    const sha = await realGitCommit(dir, ['x.md'], 'should not commit');
    expect(sha).toBeNull();
  });
});

function gymSql(initialStatus = 'pending') {
  let status = initialStatus;
  let learningLifecycle: Record<string, unknown> | null = null;
  const receiptWrites: Record<string, unknown>[] = [];
  const unsafe = vi.fn(async (query: string, params?: unknown[]) => {
    if (query.includes('SELECT * FROM harness_shared.gym_proposals')) {
      return [{
        id: 'proposal-1', workspace_id: 'ws-1', status, created_at: 1, decided_at: 2,
        original_md: 'old prompt', proposed_md: 'new prompt',
        learning_lifecycle: learningLifecycle,
        candidate_verdict: {
          candidateId: 'candidate-1', parentId: 'parent-1', recordedAt: '2026-10-01T00:00:00.000Z',
          hashes: { variantHash: 'variant-hash', parentHash: 'parent-hash', taskHash: 'task-hash' },
          evaluation: { gateResults: [{ gate: 'real-anchor-no-regress', status: 'pass' }] },
        },
      }];
    }
    if (query.includes('SET learning_lifecycle = receipt.payload::jsonb')) {
      const payloads = params?.[2] as string[];
      for (const payload of payloads) {
        learningLifecycle = JSON.parse(payload) as Record<string, unknown>;
        receiptWrites.push(learningLifecycle);
      }
      return [];
    }
    throw new Error(`unexpected unsafe query: ${query}`);
  });
  const tag = async (strings: TemplateStringsArray) => {
    const query = strings.join(' ');
    if (query.includes('UPDATE harness_shared.gym_proposals SET status')) {
      if (status !== 'pending') return { count: 0 };
      status = 'accepted';
      return { count: 1 };
    }
    if (query.includes('SELECT 1 FROM harness_shared.gym_proposals')) {
      return status === 'accepted' ? [{ '?column?': 1 }] : [];
    }
    throw new Error(`unexpected tagged query: ${query}`);
  };
  const sql = Object.assign(tag, {
    unsafe,
    begin: async (callback: (tx: unknown) => unknown) => callback(sql),
  }) as unknown as Sql;
  return { sql, receiptWrites, unsafe, get status() { return status; }, get learningLifecycle() { return learningLifecycle; } };
}

describe('acceptProposalViaCommit lifecycle receipt', () => {
  it('writes and refreshes the accepted Gym snapshot without granting common promotion authority', async () => {
    const db = gymSql();
    const result = await acceptProposalViaCommit(db.sql, {
      workspaceId: 'ws-1', harnessSlug: 'alpha', harnessDir: dir,
      proposalId: 'proposal-1', role: 'worker', proposedMd: 'new prompt', now: 3,
    });
    const replay = await acceptProposalViaCommit(db.sql, {
      workspaceId: 'ws-1', harnessSlug: 'alpha', harnessDir: dir,
      proposalId: 'proposal-1', role: 'worker', proposedMd: 'new prompt', now: 4,
    });

    expect(result).toMatchObject({ ok: true, proposalMarked: true });
    expect(replay).toMatchObject({ ok: true, proposalMarked: false });
    expect(db.status).toBe('accepted');
    expect(db.receiptWrites).toHaveLength(2);
    expect(db.learningLifecycle).toMatchObject({
      producer: 'gym', sourceRef: 'gym:proposal-1', contract: null, promotionAllowed: false,
      lifecycle: {
        stage: 'activation',
        decision: { status: 'partial', value: { verdict: 'accepted' } },
        activation: { status: 'partial' },
      },
    });
  });

  it('repairs a missing receipt for a previously accepted proposal', async () => {
    const db = gymSql('accepted');
    const result = await acceptProposalViaCommit(db.sql, {
      workspaceId: 'ws-1', harnessSlug: 'alpha', harnessDir: dir,
      proposalId: 'proposal-1', role: 'worker', proposedMd: 'new prompt', now: 4,
    });

    expect(result).toMatchObject({ ok: true, proposalMarked: false });
    expect(db.receiptWrites).toHaveLength(1);
    expect(db.learningLifecycle).toMatchObject({ contract: null, promotionAllowed: false, lifecycle: { stage: 'activation' } });
  });

  it('does not write a receipt when commit or reprojection fails', async () => {
    h.commitAndReproject.mockResolvedValueOnce({
      ok: false, committed: false, commit: null, contentHash: null,
      editedPath: '.papercusp/prompts/worker.md', blueprintPath: '.papercusp/blueprint.yaml', reason: 'reproject failed',
    });
    const db = gymSql();
    const result = await acceptProposalViaCommit(db.sql, {
      workspaceId: 'ws-1', harnessSlug: 'alpha', harnessDir: dir,
      proposalId: 'proposal-1', role: 'worker', proposedMd: 'new prompt', now: 5,
    });

    expect(result).toMatchObject({ ok: false, proposalMarked: false });
    expect(db.status).toBe('pending');
    expect(db.receiptWrites).toHaveLength(0);
    expect(db.learningLifecycle).toBeNull();
    expect(db.unsafe).not.toHaveBeenCalled();
  });
});
