/**
 * WI-6554700010018028 — the sync-batch delta check walks staging's FIRST-PARENT chain.
 *
 * A frozen repair lineage is absorbed into staging by a tree-preserving merge, and the
 * lineage carries repair-queue admission commits dated 2000-01-01 (ADMISSION_GIT_DATE).
 * `git log <cursor>..staging --no-merges` listed those side commits; git's date order put
 * them LAST, so the oldest-prefix walk judged one first and moved the cursor onto it. From
 * a side-lineage cursor, `cursor..staging` was ~9,800 commits and the check never caught up.
 *
 * This drives the REAL `listBatches` binding against a real repository with that shape.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSyncBatchDeltaDeps } from './sync-batch-delta-check-deps';

const ADMISSION_DATE = '2000-01-01T00:00:00Z';

let root = '';
const shas: Record<string, string> = {};

function git(args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', ...env },
  }).trim();
}

function commitFile(file: string, body: string, date: string, message: string): string {
  writeFileSync(join(root, file), body);
  git(['add', file]);
  git(['commit', '-q', '-m', message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  return git(['rev-parse', 'HEAD']);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'sync-delta-first-parent-'));
  git(['init', '-q', '-b', 'staging']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'user.name', 'test']);
  git(['config', 'commit.gpgsign', 'false']);
  shas.base = commitFile('a.ts', 'a1', '2026-10-01T10:00:00Z', 'base');
  // The frozen lineage branches from base and admits a fix with the synthetic date.
  git(['checkout', '-q', '-b', 'lineage']);
  shas.admission = commitFile('fix.ts', 'fix', ADMISSION_DATE, 'admit 1 path(s) onto frozen lineage base');
  git(['checkout', '-q', 'staging']);
  // git-sync lands the same content on staging directly; the cursor sits here.
  shas.cursor = commitFile('fix.ts', 'fix', '2026-10-01T10:05:00Z', 'sync: fix.ts');
  // Absorb the promoted lineage with a tree-preserving merge (staging already has the content).
  git(['merge', '-q', '-s', 'ours', '--no-edit', 'lineage'], {
    GIT_AUTHOR_DATE: '2026-10-01T10:10:00Z',
    GIT_COMMITTER_DATE: '2026-10-01T10:10:00Z',
  });
  shas.absorb = git(['rev-parse', 'HEAD']);
  shas.tip = commitFile('b.ts', 'b1', '2026-10-01T10:15:00Z', 'sync: b.ts');
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('listBatches walks the first-parent chain (WI-6554700010018028)', () => {
  it('fixture: the admission commit is reachable from staging but not from the cursor', () => {
    expect(git(['rev-list', '--no-merges', `${shas.cursor}..staging`]).split('\n')).toContain(shas.admission);
  });

  it('lists only first-parent commits newer than the cursor, never the absorbed side commit', async () => {
    const deps = buildSyncBatchDeltaDeps({ installSlug: 'h', workspaceId: 'w', root, branch: 'staging' });
    const batches = await deps.listBatches(shas.cursor!);
    expect(batches?.map((b) => b.sha)).toEqual([shas.tip, shas.absorb]);
    expect(batches?.some((b) => b.sha === shas.admission)).toBe(false);
    expect(batches?.[0]?.paths).toEqual(['b.ts']);
    // The absorbing merge changed nothing against staging's first parent.
    expect(batches?.[1]?.paths).toEqual([]);
  });

  it('caps the listing at maxListedCommits, newest first (a cursor off the chain listed 110k commits)', async () => {
    const deps = buildSyncBatchDeltaDeps({
      installSlug: 'h',
      workspaceId: 'w',
      root,
      branch: 'staging',
      maxListedCommits: 1,
    });
    const batches = await deps.listBatches(shas.cursor!);
    expect(batches?.map((b) => b.sha)).toEqual([shas.tip]);
  });
});
