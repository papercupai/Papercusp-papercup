/**
 * WI-10005560: the settlement history search memo survives a process restart.
 *
 * The restart case runs against a real git repository: a reader whose memo was hydrated
 * from a store must issue exactly as few history reads as one that kept its memo in
 * process, and fewer than a cold reader, with the same verdicts as the exact per-pair check.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  completionBlobHistoryContains,
  completionHistoryPairKey,
  createCompletionBlobHistoryReader,
  createCompletionHistorySearchMemo,
  createPersistedCompletionHistorySearchMemo,
  type CompletionHistoryMemoRecord,
  type CompletionHistoryMemoStore,
  type CompletionHistorySearchMemo,
} from '../../agent-tools/work_items/completion-freshness';
import { completionHistoryMemoRecordOf } from './completion-history-memo-store';

const ROOTS: string[] = [];
afterAll(() => {
  for (const root of ROOTS) rmSync(root, { recursive: true, force: true });
});

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

/** An in-memory store with the same last-writer-wins, newest-first contract as Postgres. */
function memoryStore(): CompletionHistoryMemoStore & { rows: Map<string, CompletionHistoryMemoRecord> } {
  const rows = new Map<string, CompletionHistoryMemoRecord>();
  return {
    rows,
    load: async (limit) => [...rows.values()].reverse().slice(0, limit),
    save: async (records) => {
      for (const record of records) {
        const key = completionHistoryPairKey(record.repositoryRoot, record.fromHeadSha, record.path, record.blobSha);
        rows.delete(key);
        rows.set(key, record);
      }
    },
  };
}

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'completion-history-persist-'));
  ROOTS.push(root);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'user.name', 'Settlement Fixture');
  const commit = (message: string, files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    git('add', '--', ...Object.keys(files));
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  return { root, git, commit };
}

describe('WI-10005560: persisted completion history search memo', () => {
  it('a restarted process resumes from the stored verdicts instead of re-searching every pair', async () => {
    const { root, git, commit } = repo();
    const closeHead = commit('close head', { 'a.ts': 'a before\n', 'b.ts': 'b before\n' });
    // Close-time blobs: a.ts's reaches a later commit; b.ts's never does.
    writeFileSync(join(root, 'a.ts'), 'a close time\n');
    const blobA = git('hash-object', '-w', 'a.ts');
    writeFileSync(join(root, 'b.ts'), 'b close time\n');
    const blobB = git('hash-object', '-w', 'b.ts');
    writeFileSync(join(root, 'b.ts'), 'b before\n');
    const firstEmit = commit('lands a.ts', { 'a.ts': 'a close time\n' });
    const secondEmit = commit('unrelated', { 'z.ts': 'z\n' });
    const blobs = new Map([
      ['a.ts', blobA],
      ['b.ts', blobB],
    ]);

    const pass = async (memo: CompletionHistorySearchMemo, to: string) => {
      const reader = createCompletionBlobHistoryReader(undefined, memo);
      const paths = [...blobs.keys()];
      reader.hint(root, to, paths);
      reader.hint(root, closeHead, paths);
      reader.hintBlobs(root, closeHead, paths.map((path) => ({ path, blobSha: blobs.get(path)! })));
      const verdicts: unknown[] = [];
      const exact: unknown[] = [];
      for (const path of paths) {
        verdicts.push(await reader.contains(root, closeHead, to, path, blobs.get(path)!));
        exact.push(await completionBlobHistoryContains(root, closeHead, to, path, blobs.get(path)!));
      }
      return { verdicts, exact, reads: reader.historyReads(), ancestry: reader.ancestryReads() };
    };

    // The process before the restart: one pass, then its verdicts are written.
    const store = memoryStore();
    const before = createPersistedCompletionHistorySearchMemo(store);
    expect(await before.hydrate()).toBe(0);
    const first = await pass(before, firstEmit);
    expect(first.verdicts).toEqual([true, false]);
    expect(first.verdicts).toEqual(first.exact);
    expect(await before.flush()).toBe(2);
    expect(store.rows.size).toBe(2);

    // Three readers at the next commit: the process that never restarted, a restarted one
    // hydrated from the store, and a restarted one with nothing persisted.
    const warm = await pass(before, secondEmit);
    const restarted = createPersistedCompletionHistorySearchMemo(store);
    expect(await restarted.hydrate()).toBe(2);
    const resumed = await pass(restarted, secondEmit);
    const cold = await pass(createCompletionHistorySearchMemo(), secondEmit);

    for (const run of [warm, resumed, cold]) {
      expect(run.verdicts).toEqual([true, false]);
      expect(run.verdicts).toEqual(run.exact);
    }
    // Warm and resumed: a.ts is re-proved by one merge-base, b.ts searches only firstEmit..secondEmit.
    expect(resumed).toMatchObject({ reads: warm.reads, ancestry: warm.ancestry });
    expect(resumed.reads).toBe(1);
    expect(resumed.ancestry).toBe(1);
    // Cold: one batched search over the whole range plus the per-pair check for the match.
    expect(cold.reads).toBe(2);
    expect(cold.ancestry).toBe(0);
  });

  it('keeps unsaved verdicts pending when the store write fails, and retries them', async () => {
    const store = memoryStore();
    const save = vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('db down'));
    const memo = createPersistedCompletionHistorySearchMemo(store);
    const key = completionHistoryPairKey('/repo', SHA_A, 'x.ts', SHA_B);
    const value = { repositoryRoot: '/repo', fromCommitSha: SHA_A, path: 'x.ts', searchedThrough: SHA_C };
    memo.set(key, value);
    await expect(memo.flush()).rejects.toThrow('db down');
    expect(store.rows.size).toBe(0);
    expect(await memo.flush()).toBe(1);
    expect(save).toHaveBeenCalledTimes(2);
    expect([...store.rows.values()]).toEqual([
      { repositoryRoot: '/repo', fromHeadSha: SHA_A, path: 'x.ts', blobSha: SHA_B, value },
    ]);
    // Nothing new since the last flush: no write at all.
    expect(await memo.flush()).toBe(0);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('retries a failed load, loads once after success, and never overwrites a verdict the process already holds', async () => {
    const store = memoryStore();
    const keyHeld = completionHistoryPairKey('/repo', SHA_A, 'held.ts', SHA_B);
    const keyStored = completionHistoryPairKey('/repo', SHA_A, 'stored.ts', SHA_B);
    const stale = { repositoryRoot: '/repo', fromCommitSha: SHA_A, path: 'held.ts', searchedThrough: SHA_A };
    const fresh = { repositoryRoot: '/repo', fromCommitSha: SHA_A, path: 'held.ts', searchedThrough: SHA_C };
    const stored = { repositoryRoot: '/repo', fromCommitSha: SHA_A, path: 'stored.ts', foundThrough: SHA_C };
    await store.save([
      { repositoryRoot: '/repo', fromHeadSha: SHA_A, path: 'held.ts', blobSha: SHA_B, value: stale },
      { repositoryRoot: '/repo', fromHeadSha: SHA_A, path: 'stored.ts', blobSha: SHA_B, value: stored },
    ]);
    const load = vi.spyOn(store, 'load').mockRejectedValueOnce(new Error('db down'));
    const memo = createPersistedCompletionHistorySearchMemo(store);
    memo.set(keyHeld, fresh);
    await expect(memo.hydrate()).rejects.toThrow('db down');
    expect(await memo.hydrate()).toBe(1);
    expect(await memo.hydrate()).toBe(1);
    expect(load).toHaveBeenCalledTimes(2);
    expect(memo.get(keyHeld)).toEqual(fresh);
    expect(memo.get(keyStored)).toEqual(stored);
  });

  it('bounds the pending queue at the memo limit, keeping the newest verdicts', async () => {
    const store = memoryStore();
    const memo = createPersistedCompletionHistorySearchMemo(store, createCompletionHistorySearchMemo(), 3);
    for (const path of ['1.ts', '2.ts', '3.ts', '4.ts', '5.ts']) {
      memo.set(completionHistoryPairKey('/repo', SHA_A, path, SHA_B), {
        repositoryRoot: '/repo',
        fromCommitSha: SHA_A,
        path,
        searchedThrough: SHA_C,
      });
    }
    expect(await memo.flush()).toBe(3);
    expect([...store.rows.values()].map((record) => record.path)).toEqual(['3.ts', '4.ts', '5.ts']);
  });
});

describe('WI-10005560: completionHistoryMemoRecordOf', () => {
  const row = {
    repository_root: '/repo',
    from_head_sha: SHA_A,
    path: 'x.ts',
    blob_sha: SHA_B,
    resolved_root: '/repo/sub',
    resolved_from_sha: SHA_C,
    resolved_path: 'y.ts',
    searched_through: SHA_C as string | null,
    found_through: null as string | null,
  };

  it('maps a no-match and a match to the reader\'s verdict shape', () => {
    expect(completionHistoryMemoRecordOf(row)).toEqual({
      repositoryRoot: '/repo',
      fromHeadSha: SHA_A,
      path: 'x.ts',
      blobSha: SHA_B,
      value: { repositoryRoot: '/repo/sub', fromCommitSha: SHA_C, path: 'y.ts', searchedThrough: SHA_C },
    });
    expect(completionHistoryMemoRecordOf({ ...row, searched_through: null, found_through: SHA_A })?.value).toEqual({
      repositoryRoot: '/repo/sub',
      fromCommitSha: SHA_C,
      path: 'y.ts',
      foundThrough: SHA_A,
    });
  });

  it('drops a row that is not exactly one well-formed verdict', () => {
    expect(completionHistoryMemoRecordOf({ ...row, found_through: SHA_A })).toBeNull();
    expect(completionHistoryMemoRecordOf({ ...row, searched_through: null })).toBeNull();
    expect(completionHistoryMemoRecordOf({ ...row, searched_through: 'HEAD' })).toBeNull();
    expect(completionHistoryMemoRecordOf({ ...row, blob_sha: 'not-a-sha' })).toBeNull();
    expect(completionHistoryMemoRecordOf({ ...row, resolved_path: '' })).toBeNull();
  });
});
